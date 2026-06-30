import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ExecutiveReportService } from '../src/reports/executive-report.service';
import { pdfHasEmbeddedImages } from '../src/reports/charts/chart-image';
import {
  shouldRenderRisk,
  shouldRenderSpendTrend,
  shouldRenderUserSpend,
  shouldRenderValueKpis,
} from '../src/reports/executive-report.should-render';
import { runWithTenant } from '../src/tenant/tenant-context';

const CH = process.env.AGENTLEDGER_CLICKHOUSE_URL ?? 'http://localhost:8123';

async function insertCH(table: string, rows: object[]): Promise<void> {
  const body = `INSERT INTO agentledger.${table} FORMAT JSONEachRow\n` + rows.map((r) => JSON.stringify(r)).join('\n');
  const res = await fetch(`${CH}/`, { method: 'POST', body });
  if (!res.ok) {
    throw new Error(`CH insert ${table} failed: ${res.status} ${await res.text()}`);
  }
}

function asBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body, 'binary');
  if (body && typeof body === 'object' && 'type' in body && 'data' in body) {
    return Buffer.from((body as { data: number[] }).data);
  }
  throw new TypeError('expected binary response body');
}

/**
 * Executive report export — PDF/XLSX against seeded spend, user allocation, risk,
 * and attributed outcomes. Requires Postgres + ClickHouse (`make e2e`).
 */
describe('Executive report export', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let prisma: PrismaService;
  let reports: ExecutiveReportService;
  const tenantFull = randomUUID();
  const tenantSpendOnly = randomUUID();
  const userId = randomUUID();
  const teamId = randomUUID();
  const agent = `agent-${tenantFull.slice(0, 8)}`;
  const runId = `run-${tenantFull.slice(0, 8)}`;
  const WIDE = { from: '2020-01-01', to: '2035-01-01' };

  beforeAll(async () => {
    process.env.AGENTLEDGER_JWT_SECRET = process.env.AGENTLEDGER_JWT_SECRET ?? 'test-secret';
    process.env.AGENTLEDGER_DEV_TRUST_HEADER = 'false';
    process.env.AGENTLEDGER_PG_DSN =
      process.env.AGENTLEDGER_PG_DSN ??
      'postgres://agentledger_api:dev_only_change_me@localhost:5432/agentledger?sslmode=disable';
    process.env.AGENTLEDGER_CLICKHOUSE_URL = CH;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    jwt = app.get(JwtService);
    prisma = app.get(PrismaService);
    reports = app.get(ExecutiveReportService);

    await prisma.withTenant(tenantFull, (tx) =>
      tx.tenant.create({
        data: {
          tenantId: tenantFull,
          name: 'Acme Corp',
          complianceFlags: { attribution_mode: 'live' },
        },
      }),
    );
    await prisma.withTenant(tenantSpendOnly, (tx) =>
      tx.tenant.create({ data: { tenantId: tenantSpendOnly, name: 'Spend Only Inc' } }),
    );
    await prisma.withTenant(tenantFull, (tx) =>
      tx.team.create({ data: { teamId, tenantId: tenantFull, name: 'Engineering' } }),
    );
    await prisma.withTenant(tenantFull, (tx) =>
      tx.identity.create({
        data: {
          userId,
          tenantId: tenantFull,
          email: 'alice@acme.test',
          displayName: 'Alice Smith',
          teamId,
        },
      }),
    );

    await request(app.getHttpServer())
      .post('/v1/roi-templates')
      .set({ Authorization: `Bearer ${await jwt.mintAccess({ userId: randomUUID(), tenantId: tenantFull, role: 'admin' })}` })
      .send({
        name: 'Merged PR',
        outcomeType: 'pr_merged',
        sourceSystem: 'github',
        valueFormula: { hourly_rate: 120, baseline_minutes: 60, qa_cost_per_outcome: 10 },
      });

    await insertCH('llm_calls', [
      {
        call_id: `er-1-${tenantFull}`,
        ts: '2026-06-10 10:00:00',
        tenant_id: tenantFull,
        team_id: teamId,
        user_id: userId,
        app_id: 'app',
        virtual_key_id: 'vk',
        agent_id: agent,
        run_id: runId,
        provider: 'openai',
        response_model: 'gpt-4o',
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 200,
        cost_usd: 8.0,
        status: 'ok',
        dlp_action: 'allow',
      },
      {
        call_id: `er-2-${tenantFull}`,
        ts: '2026-06-10 11:00:00',
        tenant_id: tenantFull,
        team_id: teamId,
        user_id: userId,
        app_id: 'app',
        virtual_key_id: 'vk',
        provider: 'anthropic',
        response_model: 'claude-3',
        input_tokens: 400,
        output_tokens: 200,
        cost_usd: 4.0,
        status: 'blocked_dlp',
        dlp_action: 'block',
        risk_severity: 'high',
      },
      {
        call_id: `er-so-${tenantSpendOnly}`,
        ts: '2026-06-10 10:00:00',
        tenant_id: tenantSpendOnly,
        team_id: 't',
        user_id: 'u',
        app_id: 'app',
        virtual_key_id: 'vk',
        provider: 'openai',
        response_model: 'gpt-4o',
        input_tokens: 50,
        output_tokens: 25,
        cost_usd: 1.0,
        status: 'ok',
        dlp_action: 'allow',
      },
    ]);
    await insertCH('agent_runs', [
      {
        run_id: runId,
        tenant_id: tenantFull,
        agent_id: agent,
        app_id: 'app',
        user_id: userId,
        started_at: '2026-06-10 10:00:00',
        ended_at: '2026-06-10 10:05:00',
        status: 'completed',
        total_cost_usd: 8.0,
        total_tokens: 1500,
        llm_calls: 1,
        tool_calls: 0,
        risk_events: 0,
      },
    ]);
    await insertCH('outcomes', [
      {
        outcome_id: `oc-er-${tenantFull}`,
        tenant_id: tenantFull,
        ts: '2026-06-10 11:00:00',
        source_system: 'github',
        outcome_type: 'pr_merged',
        team_id: teamId,
        user_id: userId,
        run_id: runId,
        business_value_usd: 0,
        quality_score: 0.9,
        attribution_confidence: 0.9,
        completion_status: 'merged',
      },
    ]);
  });

  afterAll(async () => {
    for (const t of [tenantFull, tenantSpendOnly]) {
      await prisma.withTenant(t, async (tx) => {
        await tx.roiTemplate.deleteMany({});
        await tx.identity.deleteMany({});
        await tx.team.deleteMany({});
        await tx.auditLog.deleteMany({});
        await tx.tenant.deleteMany({});
      });
    }
    await app.close();
  });

  const tok = (tenant: string) => jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role: 'viewer' });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  const buildAs = (tenantId: string) =>
    runWithTenant({ tenantId, userId: randomUUID(), role: 'viewer' }, () =>
      reports.build(WIDE.from, WIDE.to),
    );

  it('rejects unauthenticated (401)', async () => {
    expect((await request(app.getHttpServer()).get('/v1/reports/executive')).status).toBe(401);
  });

  it('generates a PDF and includes expected sections for full fixture', async () => {
    const data = await buildAs(tenantFull);
    expect(data.current.costUsd).toBeGreaterThan(0);
    expect(shouldRenderSpendTrend(data.spendTrend)).toBe(true);
    expect(shouldRenderUserSpend(data.userSpend)).toBe(true);
    expect(data.userSpend.some((u) => u.displayName === 'Alice Smith')).toBe(true);
    expect(shouldRenderValueKpis(data.attributionLive, data.valueMetrics)).toBe(true);
    expect(shouldRenderRisk(data.blockedEvents, data.risk)).toBe(true);

    const res = await request(app.getHttpServer())
      .get('/v1/reports/executive')
      .query({ ...WIDE, format: 'pdf' })
      .set(bearer(await tok(tenantFull)))
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const buf = asBuffer(res.body);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(500);
    expect(pdfHasEmbeddedImages(buf)).toBe(true);
  });

  it('omits risk section when no DLP events', async () => {
    const data = await buildAs(tenantSpendOnly);
    expect(shouldRenderRisk(data.blockedEvents, data.risk)).toBe(false);

    const res = await request(app.getHttpServer())
      .get('/v1/reports/executive')
      .query({ ...WIDE, format: 'pdf' })
      .set(bearer(await tok(tenantSpendOnly)))
      .buffer(true);
    expect(res.status).toBe(200);
    expect(asBuffer(res.body).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('generates XLSX companion', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/executive')
      .query({ ...WIDE, format: 'xlsx' })
      .set(bearer(await tok(tenantFull)))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const buf = asBuffer(res.body);
    expect(buf.subarray(0, 2).toString('hex')).toBe('504b');
  });

  it('rejects mismatched tenant_id (403)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/reports/executive')
      .query({ ...WIDE, tenant_id: randomUUID() })
      .set(bearer(await tok(tenantFull)));
    expect(res.status).toBe(403);
  });
});
