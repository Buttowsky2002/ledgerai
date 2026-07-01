import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';

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
 * Single-run detail (GET /v1/runs/:id) — the run node of the evidence chain
 * (ADR-046). Seeds a run + its outcome + a tool call in ClickHouse, then verifies
 * the API returns the run with its outcomes/tool calls, 404s on a missing run, and
 * fails closed across tenants. Requires Postgres + ClickHouse (`make e2e`).
 */
describe('Run detail (/v1/runs/:id)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const runId = `run-${tenantA.slice(0, 8)}`;
  const agentId = `agent-${tenantA.slice(0, 8)}`;

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

    const now = new Date().toISOString();
    await chInsert('agent_runs', [
      { run_id: runId, tenant_id: tenantA, agent_id: agentId, started_at: now, ended_at: now, status: 'completed', total_cost_usd: 1.25, total_tokens: 500, llm_calls: 2, tool_calls: 1, risk_events: 0 },
    ]);
    await chInsert('outcomes', [
      { outcome_id: `out-${runId}`, tenant_id: tenantA, ts: now, source_system: 'api', outcome_type: 'pr_merged', run_id: runId, business_value_usd: 300, attribution_confidence: 1, completion_status: 'completed' },
    ]);
    await chInsert('agent_tool_calls', [
      { tenant_id: tenantA, agent_id: agentId, run_id: runId, tool_call_id: `tc-${runId}`, tool_name: 'search_kb', ts: now },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  const tok = (tenant: string, role = 'viewer') => jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('rejects unauthenticated (401)', async () => {
    expect((await request(app.getHttpServer()).get(`/v1/runs/${runId}`)).status).toBe(401);
  });

  it('returns the run with its outcomes and tool calls (the evidence chain node)', async () => {
    const res = await request(app.getHttpServer()).get(`/v1/runs/${runId}`).set(bearer(await tok(tenantA)));
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ run_id: runId, agent_id: agentId, status: 'completed' });
    expect(Number(res.body.run.total_cost_usd)).toBe(1.25);
    expect((res.body.outcomes as unknown[]).length).toBe(1);
    expect(res.body.outcomes[0]).toMatchObject({ outcome_type: 'pr_merged' });
    expect((res.body.toolCalls as unknown[]).length).toBe(1);
  });

  it('404s for a missing run', async () => {
    const res = await request(app.getHttpServer()).get('/v1/runs/does-not-exist').set(bearer(await tok(tenantA)));
    expect(res.status).toBe(404);
  });

  it('isolates tenants: tenant B cannot read tenant A run (404)', async () => {
    const res = await request(app.getHttpServer()).get(`/v1/runs/${runId}`).set(bearer(await tok(tenantB)));
    expect(res.status).toBe(404);
  });
});
