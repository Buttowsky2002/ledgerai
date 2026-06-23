import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';

const CH = process.env.AGENTLEDGER_CLICKHOUSE_URL ?? 'http://localhost:8123';

/** Direct ClickHouse read (bypasses the API) to verify what the import wrote. */
async function chCount(sql: string): Promise<number> {
  const res = await fetch(`${CH}/?default_format=JSON`, { method: 'POST', body: sql });
  if (!res.ok) throw new Error(`CH query failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data?: { c: string }[] };
  return Number(json.data?.[0]?.c ?? 0);
}

/**
 * Bulk import (POST /v1/import/events). Imports usage + outcome + risk rows, then
 * verifies the canonical rows landed in ClickHouse, idempotent re-import is a
 * no-op, tenant isolation holds, and RBAC/validation fail closed. Requires
 * Postgres (migration 011 applied — `docker compose down -v` for a fresh volume)
 * + ClickHouse (`make e2e`). Fresh UUIDs per run; ClickHouse rows aren't cleaned.
 */
describe('Bulk import /v1/import/events', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let prisma: PrismaService;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const k = (s: string) => `e2e-${tenantA.slice(0, 8)}-${s}`;

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

    // Seed the tenant rows — import_idempotency has an FK to tenants.
    await prisma.withTenant(tenantA, (tx) => tx.tenant.create({ data: { tenantId: tenantA, name: 'import-a' } }));
    await prisma.withTenant(tenantB, (tx) => tx.tenant.create({ data: { tenantId: tenantB, name: 'import-b' } }));
  });

  afterAll(async () => {
    await app.close();
  });

  const tok = (tenant: string, role = 'admin') => jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const post = async (tenant: string, body: object, role = 'admin') =>
    request(app.getHttpServer()).post('/v1/import/events').set(bearer(await tok(tenant, role))).send(body);

  it('rejects unauthenticated (401)', async () => {
    expect((await request(app.getHttpServer()).post('/v1/import/events').send({ events: [] })).status).toBe(401);
  });

  it('forbids a viewer (403 — import is admin-only)', async () => {
    const res = await post(tenantA, { events: [{ model: 'gpt-4o', input_tokens: 1 }] }, 'viewer');
    expect(res.status).toBe(403);
  });

  it('rejects an empty batch (400)', async () => {
    const res = await post(tenantA, { events: [] });
    expect(res.status).toBe(400);
  });

  it('imports usage + outcome + risk rows and lands them in ClickHouse', async () => {
    const res = await post(tenantA, {
      events: [
        { idempotency_key: k('u1'), model: 'gpt-4o', provider: 'openai', input_tokens: 100, output_tokens: 50, cost_usd: 1.5, team_id: 'eng', agent_id: 'agent-x', run_id: 'run-1' },
        { idempotency_key: k('o1'), outcome_type: 'merged_pr', outcome_value_usd: 500, run_id: 'run-1' },
        { idempotency_key: k('r1'), risk_severity: 'critical', agent_id: 'agent-x', run_id: 'run-1' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ received: 3, imported: 3, skipped: 0 });
    expect(res.body.byTable).toMatchObject({ llm_calls: 1, outcomes: 1, risk_events: 1 });

    expect(await chCount(`SELECT count() c FROM agentledger.llm_calls WHERE tenant_id = '${tenantA}' AND call_id = 'imp_${k('u1')}'`)).toBe(1);
    expect(await chCount(`SELECT count() c FROM agentledger.outcomes WHERE tenant_id = '${tenantA}' AND outcome_id = 'imp_${k('o1')}_out'`)).toBe(1);
    expect(await chCount(`SELECT count() c FROM agentledger.risk_events WHERE tenant_id = '${tenantA}' AND event_id = 'imp_${k('r1')}_risk'`)).toBe(1);
  });

  it('is idempotent: re-importing the same batch skips everything (no double counting)', async () => {
    const batch = { events: [{ idempotency_key: k('u1'), model: 'gpt-4o', input_tokens: 100, cost_usd: 1.5 }] };
    const res = await post(tenantA, batch);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ received: 1, imported: 0, skipped: 1 });
    // Still exactly one row in ClickHouse for that idempotency key.
    expect(await chCount(`SELECT count() c FROM agentledger.llm_calls WHERE tenant_id = '${tenantA}' AND call_id = 'imp_${k('u1')}'`)).toBe(1);
  });

  it('dry run reports the plan without writing', async () => {
    const res = await post(tenantA, {
      dryRun: true,
      events: [{ idempotency_key: k('dry1'), model: 'gpt-4o', input_tokens: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ imported: 1, dryRun: true });
    expect(await chCount(`SELECT count() c FROM agentledger.llm_calls WHERE tenant_id = '${tenantA}' AND call_id = 'imp_${k('dry1')}'`)).toBe(0);
  });

  it('rejects a batch with an invalid row and reports the line (400)', async () => {
    const res = await post(tenantA, {
      events: [
        { model: 'gpt-4o', input_tokens: 1 },
        { team_id: 'eng' }, // line 2: no importable fields
      ],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('"line":2');
  });

  it('isolates tenants: tenant B importing its own key does not appear under tenant A', async () => {
    const res = await post(tenantB, { events: [{ idempotency_key: k('b1'), model: 'gpt-4o', input_tokens: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ imported: 1 });
    // The row exists for B...
    expect(await chCount(`SELECT count() c FROM agentledger.llm_calls WHERE tenant_id = '${tenantB}' AND call_id = 'imp_${k('b1')}'`)).toBe(1);
    // ...and never for A.
    expect(await chCount(`SELECT count() c FROM agentledger.llm_calls WHERE tenant_id = '${tenantA}' AND call_id = 'imp_${k('b1')}'`)).toBe(0);
  });
});
