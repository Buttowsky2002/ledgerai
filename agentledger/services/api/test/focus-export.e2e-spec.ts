import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { FOCUS_COLUMNS } from '../src/analytics/focus.mapper';

const CH = process.env.AGENTLEDGER_CLICKHOUSE_URL ?? 'http://localhost:8123';

async function insertCH(table: string, rows: object[]): Promise<void> {
  const body = `INSERT INTO agentledger.${table} FORMAT JSONEachRow\n` + rows.map((r) => JSON.stringify(r)).join('\n');
  const res = await fetch(`${CH}/`, { method: 'POST', body });
  if (!res.ok) {
    throw new Error(`CH insert ${table} failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * FOCUS 1.2 export (P6-E1). Seeds llm_calls (the spend_daily MV auto-populates),
 * then exports as JSON + CSV and asserts the FOCUS columns/x_ai_* extensions,
 * cost totals, and tenant isolation. Requires Postgres + ClickHouse (`make e2e`).
 * Fresh UUIDs per run (ClickHouse rows aren't cleaned up between runs).
 */
describe('FOCUS 1.2 export', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const appA = `app-${tenantA.slice(0, 8)}`;
  const appB = `app-${tenantB.slice(0, 8)}`;
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

    // Tenant A: two gpt-4o calls same day/app → one spend_daily row, cost 1.0+2.0.
    // Tenant B: a claude call (must never appear in A's export).
    await insertCH('llm_calls', [
      { call_id: `fa1-${tenantA}`, ts: '2026-06-10 10:00:00', tenant_id: tenantA, team_id: 'eng', app_id: appA, virtual_key_id: 'vk', provider: 'openai', response_model: 'gpt-4o', input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cost_usd: 1.0, status: 'ok', dlp_action: 'allow' },
      { call_id: `fa2-${tenantA}`, ts: '2026-06-10 11:00:00', tenant_id: tenantA, team_id: 'eng', app_id: appA, virtual_key_id: 'vk', provider: 'openai', response_model: 'gpt-4o', input_tokens: 200, output_tokens: 80, cache_read_tokens: 20, cost_usd: 2.0, status: 'ok', dlp_action: 'allow' },
      { call_id: `fb1-${tenantB}`, ts: '2026-06-10 10:00:00', tenant_id: tenantB, team_id: 'sales', app_id: appB, virtual_key_id: 'vk', provider: 'anthropic', response_model: 'claude-3-5-sonnet', input_tokens: 300, output_tokens: 90, cost_usd: 5.0, status: 'ok', dlp_action: 'allow' },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  const tok = (tenant: string, role = 'viewer') => jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('rejects unauthenticated (401)', async () => {
    expect((await request(app.getHttpServer()).get('/v1/analytics/focus-export')).status).toBe(401);
  });

  it('exports JSON with FOCUS columns + x_ai_* extensions, tenant-scoped', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/focus-export')
      .query({ ...WIDE, format: 'json' })
      .set(bearer(await tok(tenantA)));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const aRows = res.body.filter((r: { ResourceId: string }) => r.ResourceId === appA);
    expect(aRows.length).toBeGreaterThanOrEqual(1);
    const row = aRows[0];
    // FOCUS base + extension columns present
    for (const col of ['BilledCost', 'EffectiveCost', 'ServiceName', 'ProviderName', 'x_ai_model', 'x_ai_input_tokens']) {
      expect(row).toHaveProperty(col);
    }
    expect(row.ProviderName).toBe('openai');
    expect(row.x_ai_model).toBe('gpt-4o');
    expect(row.BillingAccountId).toBe(tenantA);
    // cost of the day's gpt-4o rows summed = 3.0
    const total = aRows.reduce((s: number, r: { BilledCost: number }) => s + Number(r.BilledCost), 0);
    expect(total).toBeCloseTo(3.0, 5);

    // Tenant isolation: A's export never contains B's app or claude.
    expect(res.body.some((r: { ResourceId: string }) => r.ResourceId === appB)).toBe(false);
    expect(res.body.some((r: { x_ai_model: string }) => r.x_ai_model === 'claude-3-5-sonnet')).toBe(false);
  });

  it('exports CSV with the canonical header and attachment headers', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/focus-export')
      .query(WIDE) // default format = csv
      .set(bearer(await tok(tenantA)));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe(FOCUS_COLUMNS.join(','));
    expect(res.text).toContain('openai gpt-4o usage');
  });

  it('rejects an invalid format (400)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/focus-export')
      .query({ ...WIDE, format: 'xml' })
      .set(bearer(await tok(tenantA)));
    expect(res.status).toBe(400);
  });
});
