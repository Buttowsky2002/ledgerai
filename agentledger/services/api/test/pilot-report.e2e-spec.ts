import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';

const CH = process.env.AGENTLEDGER_CLICKHOUSE_URL ?? 'http://localhost:8123';

async function insertCH(table: string, rows: object[]): Promise<void> {
  const body = `INSERT INTO agentledger.${table} FORMAT JSONEachRow\n` + rows.map((r) => JSON.stringify(r)).join('\n');
  const res = await fetch(`${CH}/`, { method: 'POST', body });
  if (!res.ok) {
    throw new Error(`CH insert ${table} failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * 30-day pilot report (P6-E2). Seeds an end-to-end fixture (calls → run → an
 * attributed, high-confidence outcome) and asserts the report's spend / unit-
 * economics / ROI / governance sections populate and trace to source views, and
 * that the report is tenant-isolated. Requires Postgres + ClickHouse (`make e2e`).
 */
describe('Pilot report', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const tenantA = randomUUID();
  const tenantEmpty = randomUUID();
  const agentA = `agent-${tenantA.slice(0, 8)}`;
  const runA = `run-${tenantA.slice(0, 8)}`;
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

    await insertCH('llm_calls', [
      { call_id: `pr-a1-${tenantA}`, ts: '2026-06-10 10:00:00', tenant_id: tenantA, team_id: 'eng', app_id: 'app', virtual_key_id: 'vk', agent_id: agentA, run_id: runA, provider: 'openai', response_model: 'gpt-4o', input_tokens: 100, output_tokens: 50, cost_usd: 4.0, status: 'ok', dlp_action: 'allow' },
      { call_id: `pr-a2-${tenantA}`, ts: '2026-06-10 10:05:00', tenant_id: tenantA, team_id: 'eng', app_id: 'app', virtual_key_id: 'vk', agent_id: agentA, run_id: runA, provider: 'openai', response_model: 'gpt-4o', input_tokens: 80, output_tokens: 40, cost_usd: 2.0, status: 'blocked_dlp', dlp_action: 'block', risk_severity: 'high' },
    ]);
    await insertCH('agent_runs', [
      { run_id: runA, tenant_id: tenantA, agent_id: agentA, app_id: 'app', user_id: 'u', started_at: '2026-06-10 10:00:00', ended_at: '2026-06-10 10:06:00', status: 'completed', total_cost_usd: 6.0, total_tokens: 270, llm_calls: 2, tool_calls: 0, risk_events: 1 },
    ]);
    await insertCH('outcomes', [
      { outcome_id: `oc-${tenantA}`, tenant_id: tenantA, ts: '2026-06-10 11:00:00', source_system: 'github', outcome_type: 'pr_merged', team_id: 'eng', user_id: 'u', run_id: runA, business_value_usd: 1000, quality_score: 0.9, attribution_confidence: 0.95, completion_status: 'merged' },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  const tok = (tenant: string) => jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role: 'viewer' });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('rejects unauthenticated (401)', async () => {
    expect((await request(app.getHttpServer()).get('/v1/analytics/pilot-report')).status).toBe(401);
  });

  it('returns a populated, source-traced JSON report', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/pilot-report')
      .query(WIDE)
      .set(bearer(await tok(tenantA)));
    expect(res.status).toBe(200);
    const b = res.body;
    // spend: 4.0 + 2.0 = 6.0, one blocked call
    expect(b.spend.source).toBe('spend_daily');
    expect(Number(b.spend.totalCostUsd)).toBeCloseTo(6.0, 5);
    expect(Number(b.spend.blockedCalls)).toBeGreaterThanOrEqual(1);
    // top agent attributed
    expect(b.topAgents.agents.some((a: { agentId: string }) => a.agentId === agentA)).toBe(true);
    // unit economics + ROI from the attributed high-confidence outcome
    expect(b.unitEconomics.source).toBe('outcomes + agent_runs');
    expect(Number(b.unitEconomics.outcomes)).toBeGreaterThanOrEqual(1);
    expect(Number(b.unitEconomics.businessValueUsd)).toBeGreaterThanOrEqual(1000);
    expect(b.roi.source).toBe('v_roi');
    expect(Number(b.roi.outcomes)).toBeGreaterThanOrEqual(1);
    // governance: the blocked + high-severity call
    expect(b.governance.source).toBe('risk_daily');
    expect(Number(b.governance.highSeverityEvents)).toBeGreaterThanOrEqual(1);
  });

  it('renders Markdown with ?format=md', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/pilot-report')
      .query({ ...WIDE, format: 'md' })
      .set(bearer(await tok(tenantA)));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.text).toContain('# AgentLedger Pilot Report');
    expect(res.text).toContain('## Risk-adjusted ROI');
  });

  it('is tenant-isolated: an unrelated tenant gets an empty report', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/pilot-report')
      .query(WIDE)
      .set(bearer(await tok(tenantEmpty)));
    expect(res.status).toBe(200);
    expect(Number(res.body.spend.totalCostUsd)).toBe(0);
    expect(res.body.topAgents.agents).toHaveLength(0);
    expect(Number(res.body.roi.outcomes)).toBe(0);
  });

  it('rejects an invalid format (400)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/pilot-report')
      .query({ ...WIDE, format: 'pdf' })
      .set(bearer(await tok(tenantA)));
    expect(res.status).toBe(400);
  });
});
