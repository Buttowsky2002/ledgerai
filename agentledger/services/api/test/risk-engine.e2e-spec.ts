import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';

const CH = process.env.AGENTLEDGER_CLICKHOUSE_URL ?? 'http://localhost:8123';

async function insertCH(table: string, rows: object[]): Promise<void> {
  const body = `INSERT INTO agentledger.${table} FORMAT JSONEachRow\n` + rows.map((r) => JSON.stringify(r)).join('\n');
  const res = await fetch(`${CH}/`, { method: 'POST', body });
  if (!res.ok) throw new Error(`CH insert ${table} failed: ${res.status} ${await res.text()}`);
}
async function queryCH(sql: string): Promise<string> {
  const res = await fetch(`${CH}/?default_format=TabSeparated`, { method: 'POST', body: sql });
  if (!res.ok) throw new Error(`CH query failed: ${res.status} ${await res.text()}`);
  return (await res.text()).trim();
}

/**
 * Phase 5 acceptance via the API: a governed risk event for an agent shows in the
 * CISO register (/v1/analytics/agent-risk) and lowers that agent's risk-adjusted
 * ROI (/v1/analytics/roi); plus the tool-allowlist CRUD projects into ClickHouse.
 * The risk-engine worker that derives those events is covered by its own Go
 * integration test; here we seed its outputs and verify the API surfaces them.
 * Requires Postgres + ClickHouse up.
 */
describe('Risk engine + governance (api)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let prisma: PrismaService;
  const tenant = randomUUID();
  const agent = randomUUID();
  const WIDE = { from: '2020-01-01', to: '2035-01-01' };

  beforeAll(async () => {
    process.env.AGENTLEDGER_JWT_SECRET = process.env.AGENTLEDGER_JWT_SECRET ?? 'test-secret';
    process.env.AGENTLEDGER_DEV_TRUST_HEADER = 'false';
    process.env.AGENTLEDGER_PG_DSN =
      process.env.AGENTLEDGER_PG_DSN ??
      'postgres://agentledger_api:dev_only_change_me@localhost:5432/agentledger?sslmode=disable';
    process.env.AGENTLEDGER_CLICKHOUSE_URL = CH;
    process.env.AGENTLEDGER_CLICKHOUSE_DB = 'agentledger';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    jwt = app.get(JwtService);
    prisma = app.get(PrismaService);

    await prisma.withTenant(tenant, async (tx) => {
      await tx.tenant.create({ data: { tenantId: tenant, name: 'risk' } });
      await tx.agent.create({ data: { agentId: agent, tenantId: tenant, name: 'Refactor Agent' } });
    });
  });

  afterAll(async () => {
    await prisma.withTenant(tenant, async (tx) => {
      await tx.agentToolAllowlist.deleteMany({});
      await tx.auditLog.deleteMany({});
      await tx.agent.deleteMany({});
      await tx.tenant.deleteMany({});
    });
    await app.close();
  });

  const tok = (role = 'admin') => jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('tool-allowlist CRUD projects into ClickHouse (allow then tombstone)', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/agent-tool-allowlist')
      .set(bearer(await tok('admin')))
      .send({ agentId: agent, toolName: 'search' });
    expect(created.status).toBe(201);

    const allowed = await queryCH(
      `SELECT allowed FROM agentledger.agent_tool_allow FINAL WHERE tenant_id='${tenant}' AND agent_id='${agent}' AND tool_name='search'`,
    );
    expect(allowed).toBe('1');

    const del = await request(app.getHttpServer())
      .delete(`/v1/agent-tool-allowlist/${created.body.allowId}`)
      .set(bearer(await tok('admin')));
    expect(del.status).toBe(200);

    const tombstoned = await queryCH(
      `SELECT allowed FROM agentledger.agent_tool_allow FINAL WHERE tenant_id='${tenant}' AND agent_id='${agent}' AND tool_name='search'`,
    );
    expect(tombstoned).toBe('0');
  });

  it('a governed risk event shows in the CISO register and lowers risk-adjusted ROI', async () => {
    // ROI inputs: template rate, agent run (cost), attributed outcome.
    await insertCH('roi_rates', [
      { tenant_id: tenant, source_system: 'github', outcome_type: 'pr_merged', hourly_rate: 120, baseline_minutes: 60, updated_at: '2026-06-10 09:00:00.000' },
    ]);
    await insertCH('agent_runs', [
      { run_id: 'r1', tenant_id: tenant, agent_id: agent, app_id: 'app', user_id: 'u', started_at: '2026-06-10 09:00:00', ended_at: '2026-06-10 09:05:00', status: 'completed', total_cost_usd: 5, total_tokens: 10, llm_calls: 1, tool_calls: 3, risk_events: 1 },
    ]);
    await insertCH('outcomes', [
      { outcome_id: 'o1', tenant_id: tenant, ts: '2026-06-10 09:10:00', source_system: 'github', outcome_type: 'pr_merged', team_id: 't', user_id: 'u', run_id: 'r1', business_value_usd: 0, quality_score: 0.9, attribution_confidence: 0.9, completion_status: 'merged' },
    ]);
    // The risk-engine's outputs (validated in its Go integration test).
    await insertCH('risk_events', [
      { event_id: `unauthorized_tool:${agent}:shell_exec`, tenant_id: tenant, agent_id: agent, run_id: 'r1', category: 'unauthorized_tool', severity: 'high', detail: 'shell_exec', occurrences: 2, first_seen: '2026-06-10 09:02:00.000', detected_at: '2026-06-10 09:20:00.000' },
    ]);
    await insertCH('agent_risk', [
      { tenant_id: tenant, agent_id: agent, risk_exposure_pct: 0.6667, updated_at: '2026-06-10 09:20:00.000' },
    ]);

    // CISO register surfaces the governed event for the agent.
    const reg = await request(app.getHttpServer()).get('/v1/analytics/agent-risk').set(bearer(await tok('viewer')));
    expect(reg.status).toBe(200);
    const row = reg.body.find((r: { agent_id: string }) => r.agent_id === agent);
    expect(row).toBeDefined();
    expect(row.latest_category).toBe('unauthorized_tool');
    expect(Number(row.events)).toBeGreaterThanOrEqual(1);
    expect(Number(row.risk_exposure_pct)).toBeCloseTo(0.6667, 3);

    // Risk-adjusted ROI is discounted by the exposure (well below expected).
    const roi = await request(app.getHttpServer())
      .get('/v1/analytics/roi')
      .query({ ...WIDE, outcomeType: 'pr_merged', minConfidence: 0 })
      .set(bearer(await tok('viewer')));
    expect(roi.status).toBe(200);
    const r = roi.body.find((x: { outcome_type: string }) => x.outcome_type === 'pr_merged');
    expect(r).toBeDefined();
    // value 120, fully-loaded 5 → expected 120*0.9-5=103; risk-adjusted 120*0.9*(1-0.6667)-5 ≈ 31.
    expect(Number(r.risk_adjusted_roi_usd)).toBeLessThan(Number(r.expected_roi_usd));
    expect(Number(r.risk_adjusted_roi_usd)).toBeCloseTo(31.0, 0);
  });
});
