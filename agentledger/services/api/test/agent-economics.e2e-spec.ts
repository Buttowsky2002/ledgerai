import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';

const CH = process.env.BADGERIQ_CLICKHOUSE_URL ?? 'http://localhost:8123';

async function chInsert(table: string, rows: object[]): Promise<void> {
  const body =
    `INSERT INTO agentledger.${table} FORMAT JSONEachRow\n` + rows.map((r) => JSON.stringify(r)).join('\n');
  const res = await fetch(`${CH}/?date_time_input_format=best_effort&input_format_skip_unknown_fields=1`, {
    method: 'POST',
    body,
  });
  if (!res.ok) throw new Error(`CH insert failed: ${res.status} ${await res.text()}`);
}

/**
 * GET /v1/analytics/agent-economics — per-agent LARI rollup that powers the overview
 * recommendations panel + table. Seeds a run + spend + outcome, asserts the agent
 * appears with a recommendation, and that it is tenant-scoped. Requires PG + CH.
 */
describe('Agent economics (/v1/analytics/agent-economics)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let prisma: PrismaService;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const agentId = `econ-agent-${tenantA.slice(0, 8)}`;
  const runId = `econ-run-${tenantA.slice(0, 8)}`;
  const now = new Date().toISOString();

  beforeAll(async () => {
    process.env.BADGERIQ_JWT_SECRET = process.env.BADGERIQ_JWT_SECRET ?? 'test-secret';
    process.env.BADGERIQ_DEV_TRUST_HEADER = 'false';
    process.env.BADGERIQ_PG_DSN =
      process.env.BADGERIQ_PG_DSN ??
      'postgres://agentledger_api:dev_only_change_me@localhost:5432/agentledger?sslmode=disable';
    process.env.BADGERIQ_CLICKHOUSE_URL = CH;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    jwt = app.get(JwtService);
    prisma = app.get(PrismaService);

    await prisma.withTenant(tenantA, (tx) => tx.tenant.create({ data: { tenantId: tenantA, name: 'econ-a' } }));
    await prisma.withTenant(tenantB, (tx) => tx.tenant.create({ data: { tenantId: tenantB, name: 'econ-b' } }));

    await chInsert('agent_runs', [
      { run_id: runId, tenant_id: tenantA, agent_id: agentId, started_at: now, ended_at: now, status: 'completed', total_cost_usd: 3, total_tokens: 1500, llm_calls: 4, tool_calls: 1, risk_events: 0 },
    ]);
    await chInsert('spend_hourly_by_key', [
      { hour: now, tenant_id: tenantA, virtual_key_id: '', agent_id: agentId, calls: 4, cost_usd: 3, total_tokens: 1500 },
    ]);
    await chInsert('outcomes', [
      { outcome_id: `econ-out-${runId}`, tenant_id: tenantA, ts: now, source_system: 'erp', outcome_type: 'invoice_processed', run_id: runId, business_value_usd: 500, attribution_confidence: 0.9, completion_status: 'completed' },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  const tok = (tenant: string) => jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role: 'viewer' });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const VALID = ['scale', 'maintain', 'optimize', 'improve_evidence', 'require_approval', 'investigate', 'pause', 'retire'];

  it('rejects unauthenticated (401)', async () => {
    expect((await request(app.getHttpServer()).get('/v1/analytics/agent-economics')).status).toBe(401);
  });

  it('returns the agent with a LARI recommendation', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/agent-economics')
      .set(bearer(await tok(tenantA)));
    expect(res.status).toBe(200);
    const row = (res.body as { agentId: string; recommendation: string; value_usd: number }[]).find(
      (r) => r.agentId === agentId,
    );
    expect(row).toBeDefined();
    expect(row!.value_usd).toBeGreaterThan(0);
    expect(VALID).toContain(row!.recommendation);
  });

  it('is tenant-scoped: tenant B does not see tenant A agents', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/agent-economics')
      .set(bearer(await tok(tenantB)));
    expect(res.status).toBe(200);
    expect((res.body as { agentId: string }[]).some((r) => r.agentId === agentId)).toBe(false);
  });
});
