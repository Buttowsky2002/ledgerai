import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';

const CH = process.env.AGENTLEDGER_CLICKHOUSE_URL ?? 'http://localhost:8123';

/** Insert rows via the ClickHouse HTTP JSONEachRow interface; MVs auto-populate. */
async function insertCH(table: string, rows: object[]): Promise<void> {
  const body = `INSERT INTO agentledger.${table} FORMAT JSONEachRow\n` + rows.map((r) => JSON.stringify(r)).join('\n');
  const res = await fetch(`${CH}/`, { method: 'POST', body });
  if (!res.ok) {
    throw new Error(`CH insert ${table} failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Analytics over ClickHouse MVs — the key assertion is tenant isolation, which in
 * ClickHouse depends entirely on the API's injected tenant filter (no RLS there).
 * Requires Postgres + ClickHouse up. Tenants use fresh UUIDs so runs don't collide
 * (ClickHouse rows aren't cleaned up between runs).
 */
describe('Analytics (ClickHouse MVs)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const agentA = `agent-${tenantA.slice(0, 8)}`;
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

    // Tenant A: gpt-4o, cost 1.0 + 2.0, one blocked (risk). Tenant B: claude, cost 5.0.
    await insertCH('llm_calls', [
      { call_id: 'a1', ts: '2026-06-10 10:00:00', tenant_id: tenantA, team_id: 'team-a', app_id: 'app-a', virtual_key_id: 'vk-a', agent_id: agentA, provider: 'openai', response_model: 'gpt-4o', input_tokens: 100, output_tokens: 50, cost_usd: 1.0, status: 'ok', dlp_action: 'allow' },
      { call_id: 'a2', ts: '2026-06-10 11:00:00', tenant_id: tenantA, team_id: 'team-a', app_id: 'app-a', virtual_key_id: 'vk-a', agent_id: agentA, provider: 'openai', response_model: 'gpt-4o', input_tokens: 200, output_tokens: 80, cost_usd: 2.0, status: 'blocked_dlp', dlp_action: 'block', risk_severity: 'high' },
      { call_id: 'b1', ts: '2026-06-10 10:00:00', tenant_id: tenantB, team_id: 'team-b', app_id: 'app-b', virtual_key_id: 'vk-b', agent_id: 'agent-b', provider: 'anthropic', response_model: 'claude-3-5-sonnet', input_tokens: 300, output_tokens: 90, cost_usd: 5.0, status: 'ok', dlp_action: 'allow' },
    ]);
    await insertCH('agent_runs', [
      { run_id: 'r1', tenant_id: tenantA, agent_id: agentA, app_id: 'app-a', user_id: 'u', started_at: '2026-06-10 10:00:00', ended_at: '2026-06-10 10:05:00', status: 'completed', total_cost_usd: 3.0, total_tokens: 430, llm_calls: 2, tool_calls: 0, risk_events: 1 },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  const tok = (tenant: string, role = 'admin') => jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('rejects unauthenticated (401)', async () => {
    expect((await request(app.getHttpServer()).get('/v1/analytics/spend')).status).toBe(401);
  });

  it('viewer sees their tenant spend (sum matches seeded cost)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/spend')
      .query(WIDE)
      .set(bearer(await tok(tenantA, 'viewer')));
    expect(res.status).toBe(200);
    const total = res.body.reduce((s: number, r: { cost_usd: number }) => s + Number(r.cost_usd), 0);
    expect(total).toBeCloseTo(3.0, 5);
  });

  it('model-mix is tenant-isolated (A sees gpt-4o, not claude; B vice versa)', async () => {
    const a = await request(app.getHttpServer()).get('/v1/analytics/model-mix').query(WIDE).set(bearer(await tok(tenantA)));
    const aModels = a.body.map((r: { model: string }) => r.model);
    expect(aModels).toContain('gpt-4o');
    expect(aModels).not.toContain('claude-3-5-sonnet');

    const b = await request(app.getHttpServer()).get('/v1/analytics/model-mix').query(WIDE).set(bearer(await tok(tenantB)));
    const bModels = b.body.map((r: { model: string }) => r.model);
    expect(bModels).toContain('claude-3-5-sonnet');
    expect(bModels).not.toContain('gpt-4o');
  });

  it('risk reflects the blocked call', async () => {
    const res = await request(app.getHttpServer()).get('/v1/analytics/risk').query(WIDE).set(bearer(await tok(tenantA)));
    expect(res.status).toBe(200);
    const events = res.body.reduce((s: number, r: { events: number }) => s + Number(r.events), 0);
    expect(events).toBeGreaterThanOrEqual(1);
    expect(res.body.some((r: { dlp_action: string }) => r.dlp_action === 'block')).toBe(true);
  });

  it('allocation by team is tenant-scoped', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/allocation')
      .query({ ...WIDE, dimension: 'team' })
      .set(bearer(await tok(tenantA)));
    expect(res.status).toBe(200);
    const keys = res.body.map((r: { key: string }) => r.key);
    expect(keys).toContain('team-a');
    expect(keys).not.toContain('team-b');
  });

  it('agent detail returns spend + run aggregates', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/analytics/agents/${agentA}`)
      .query(WIDE)
      .set(bearer(await tok(tenantA)));
    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(agentA);
    expect(Number(res.body.runs.runs)).toBeGreaterThanOrEqual(1);
    expect(Number(res.body.spend.cost_usd)).toBeCloseTo(3.0, 5);
  });

  it('rejects an invalid allocation dimension (400)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/allocation')
      .query({ ...WIDE, dimension: 'bogus' })
      .set(bearer(await tok(tenantA)));
    expect(res.status).toBe(400);
  });

  it('unit-economics excludes low-confidence outcomes from headline numbers', async () => {
    const tenantUE = randomUUID();
    // Two completed runs with distinct cost, one high- and one low-confidence outcome.
    await insertCH('agent_runs', [
      { run_id: 'ue-r1', tenant_id: tenantUE, agent_id: 'a', app_id: 'app', user_id: 'u', started_at: '2026-06-10 09:00:00', ended_at: '2026-06-10 09:05:00', status: 'completed', total_cost_usd: 2.0, total_tokens: 10, llm_calls: 1, tool_calls: 0, risk_events: 0 },
      { run_id: 'ue-r2', tenant_id: tenantUE, agent_id: 'a', app_id: 'app', user_id: 'u', started_at: '2026-06-10 09:10:00', ended_at: '2026-06-10 09:15:00', status: 'completed', total_cost_usd: 8.0, total_tokens: 10, llm_calls: 1, tool_calls: 0, risk_events: 0 },
    ]);
    await insertCH('outcomes', [
      { outcome_id: 'ue-hi', tenant_id: tenantUE, ts: '2026-06-10 10:00:00', source_system: 'zendesk', outcome_type: 'ticket_resolved', team_id: 'team-ue', user_id: 'u', run_id: 'ue-r1', business_value_usd: 500, quality_score: 0.9, attribution_confidence: 0.95, completion_status: 'solved' },
      { outcome_id: 'ue-lo', tenant_id: tenantUE, ts: '2026-06-10 11:00:00', source_system: 'zendesk', outcome_type: 'ticket_resolved', team_id: 'team-ue', user_id: 'u', run_id: 'ue-r2', business_value_usd: 300, quality_score: 0.4, attribution_confidence: 0.30, completion_status: 'solved' },
    ]);
    const sum = (body: { [k: string]: unknown }[], key: string) => body.reduce((s, r) => s + Number(r[key]), 0);

    // Unfiltered: both outcomes, ai_cost = 2 + 8, cost_per_outcome = 10/2 = 5.
    const all = await request(app.getHttpServer()).get('/v1/analytics/unit-economics').query(WIDE).set(bearer(await tok(tenantUE, 'viewer')));
    expect(all.status).toBe(200);
    expect(sum(all.body, 'outcomes')).toBe(2);
    expect(sum(all.body, 'ai_cost_usd')).toBeCloseTo(10.0, 5);

    // minConfidence 0.5 excludes the 0.30 outcome: 1 outcome, ai_cost = 2, cost_per_outcome = 2.
    const filtered = await request(app.getHttpServer()).get('/v1/analytics/unit-economics').query({ ...WIDE, minConfidence: 0.5 }).set(bearer(await tok(tenantUE, 'viewer')));
    expect(filtered.status).toBe(200);
    expect(sum(filtered.body, 'outcomes')).toBe(1);
    expect(sum(filtered.body, 'ai_cost_usd')).toBeCloseTo(2.0, 5);
    expect(Number(filtered.body[0].cost_per_outcome)).toBeCloseTo(2.0, 5);
  });

  it('rejects an out-of-range minConfidence (400)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/unit-economics')
      .query({ ...WIDE, minConfidence: 5 })
      .set(bearer(await tok(tenantA, 'viewer')));
    expect(res.status).toBe(400);
  });
});
