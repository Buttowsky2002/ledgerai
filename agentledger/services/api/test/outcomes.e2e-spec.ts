import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';

const CH = process.env.AGENTLEDGER_CLICKHOUSE_URL ?? 'http://localhost:8123';

/** Direct ClickHouse insert (bypasses the API) to seed runs the outcomes link to. */
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
 * Outcome Graph MVP — outcomes read/write + per-agent ROI (ADR-046). Seeds an
 * agent_run in ClickHouse, creates an outcome via the API linked to that run, then
 * verifies the cost→outcome read paths and tenant isolation. Requires Postgres
 * (fresh volume so migrations apply) + ClickHouse. ClickHouse rows aren't cleaned;
 * fresh UUIDs per run keep tests independent.
 */
describe('Outcomes + agent ROI (/v1/outcomes, /v1/agents/:id/roi)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let prisma: PrismaService;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const agentId = `agent-${tenantA.slice(0, 8)}`;
  const runId = `run-${tenantA.slice(0, 8)}`;

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

    await prisma.withTenant(tenantA, (tx) => tx.tenant.create({ data: { tenantId: tenantA, name: 'oc-a' } }));
    await prisma.withTenant(tenantB, (tx) => tx.tenant.create({ data: { tenantId: tenantB, name: 'oc-b' } }));

    // Seed the agent run (the cost side of the chain) for tenant A.
    await chInsert('agent_runs', [
      {
        run_id: runId,
        tenant_id: tenantA,
        agent_id: agentId,
        user_id: 'u1',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        status: 'completed',
        total_cost_usd: 2.5,
        total_tokens: 1000,
        llm_calls: 3,
        tool_calls: 1,
        risk_events: 0,
      },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  const tok = (tenant: string, role = 'analyst') => jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('rejects unauthenticated reads (401)', async () => {
    expect((await request(app.getHttpServer()).get('/v1/outcomes')).status).toBe(401);
  });

  it('forbids a viewer from creating an outcome (403 — POST is analyst+)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/outcomes')
      .set(bearer(await tok(tenantA, 'viewer')))
      .send({ outcomeType: 'pr_merged', valueUsd: 1 });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown field (400 — forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/outcomes')
      .set(bearer(await tok(tenantA)))
      .send({ outcomeType: 'pr_merged', valueUsd: 1, bogus: 'x' });
    expect(res.status).toBe(400);
  });

  it('creates an outcome linked to a run and reads it back with its run cost', async () => {
    const create = await request(app.getHttpServer())
      .post('/v1/outcomes')
      .set(bearer(await tok(tenantA)))
      .send({ outcomeType: 'pr_merged', valueUsd: 500, runId, confidence: 0.9 });
    expect(create.status).toBe(201);
    expect(create.body.outcome_id).toMatch(/^out_[0-9a-f]{32}$/);
    expect(create.body).toMatchObject({ value_usd: 500, source: 'api', run_id: runId });

    const list = await request(app.getHttpServer())
      .get('/v1/outcomes')
      .query({ agentId })
      .set(bearer(await tok(tenantA, 'viewer')));
    expect(list.status).toBe(200);
    const row = (list.body as Record<string, unknown>[]).find((r) => r.outcome_id === create.body.outcome_id);
    expect(row).toBeDefined();
    expect(Number(row!.value_usd)).toBe(500);
    expect(Number(row!.cost_usd)).toBe(2.5); // the linked run's AI cost
  });

  it('returns per-agent ROI summary (cost → outcome economics)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/agents/${agentId}/roi`)
      .set(bearer(await tok(tenantA, 'viewer')));
    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(agentId);
    expect(Number(res.body.summary.outcomes_count)).toBeGreaterThanOrEqual(1);
    expect(Number(res.body.summary.value_usd)).toBeGreaterThanOrEqual(500);
    expect(Number(res.body.summary.cost_usd)).toBeGreaterThanOrEqual(2.5);
  });

  it('isolates tenants: tenant B cannot see tenant A outcomes or ROI', async () => {
    const list = await request(app.getHttpServer())
      .get('/v1/outcomes')
      .query({ agentId })
      .set(bearer(await tok(tenantB, 'viewer')));
    expect(list.status).toBe(200);
    expect((list.body as unknown[]).length).toBe(0);

    const roi = await request(app.getHttpServer())
      .get(`/v1/agents/${agentId}/roi`)
      .set(bearer(await tok(tenantB, 'viewer')));
    expect(roi.status).toBe(200);
    expect(Number(roi.body.summary.outcomes_count)).toBe(0);
  });
});
