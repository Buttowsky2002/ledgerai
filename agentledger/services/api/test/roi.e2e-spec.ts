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
  if (!res.ok) {
    throw new Error(`CH insert ${table} failed: ${res.status} ${await res.text()}`);
  }
}

async function queryCH(sql: string): Promise<string> {
  const res = await fetch(`${CH}/?default_format=TabSeparated`, { method: 'POST', body: sql });
  if (!res.ok) {
    throw new Error(`CH query failed: ${res.status} ${await res.text()}`);
  }
  return (await res.text()).trim();
}

/**
 * Phase 4 acceptance for the ROI engine: a risk-adjusted ROI figure is produced
 * from the template + graph and traces fully back to its source events. Requires
 * Postgres + ClickHouse up (api e2e compose).
 */
describe('ROI engine (v_roi)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let prisma: PrismaService;
  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const agent = `agent-${tenant.slice(0, 8)}`;
  const runId = `roi-r-${tenant.slice(0, 8)}`;
  const callId = `roi-call-${tenant.slice(0, 8)}`;
  const outcomeId = `roi-o-${tenant.slice(0, 8)}`;
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

    // roi_templates.tenant_id FK → tenants, so the tenant rows must exist first.
    await prisma.withTenant(tenant, (tx) => tx.tenant.create({ data: { tenantId: tenant, name: 'roi' } }));
    await prisma.withTenant(otherTenant, (tx) => tx.tenant.create({ data: { tenantId: otherTenant, name: 'other' } }));
  });

  afterAll(async () => {
    for (const t of [tenant, otherTenant]) {
      await prisma.withTenant(t, async (tx) => {
        await tx.roiTemplate.deleteMany({});
        await tx.auditLog.deleteMany({});
        await tx.tenant.deleteMany({});
      });
    }
    await app.close();
  });

  const tok = (t: string, role = 'admin') => jwt.mintAccess({ userId: randomUUID(), tenantId: t, role });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('computes a risk-adjusted ROI that traces back to source events', async () => {
    // 1. Create the ROI template via the API — this projects its rates into the
    //    ClickHouse roi_rates table that v_roi reads.
    const created = await request(app.getHttpServer())
      .post('/v1/roi-templates')
      .set(bearer(await tok(tenant, 'admin')))
      .send({
        name: 'Merged PR',
        outcomeType: 'pr_merged',
        sourceSystem: 'github',
        valueFormula: { hourly_rate: 120, baseline_minutes: 60, qa_cost_per_outcome: 10 },
      });
    expect(created.status).toBe(201);

    // 2. Seed the source event (llm_call), its agent run, the attributed outcome,
    //    and the agent's risk exposure (the P5 seam).
    await insertCH('llm_calls', [
      { call_id: callId, ts: '2026-06-10 10:00:00', tenant_id: tenant, team_id: 't', app_id: 'app', virtual_key_id: 'vk', agent_id: agent, run_id: runId, provider: 'openai', response_model: 'gpt-4o', input_tokens: 100, output_tokens: 50, cost_usd: 5.0, status: 'ok', dlp_action: 'allow' },
    ]);
    await insertCH('agent_runs', [
      { run_id: runId, tenant_id: tenant, agent_id: agent, app_id: 'app', user_id: 'u', started_at: '2026-06-10 10:00:00', ended_at: '2026-06-10 10:05:00', status: 'completed', total_cost_usd: 5.0, total_tokens: 150, llm_calls: 1, tool_calls: 0, risk_events: 0 },
    ]);
    await insertCH('outcomes', [
      { outcome_id: outcomeId, tenant_id: tenant, ts: '2026-06-10 10:10:00', source_system: 'github', outcome_type: 'pr_merged', team_id: 't', user_id: 'u', run_id: runId, business_value_usd: 0, quality_score: 0.9, attribution_confidence: 0.9, completion_status: 'merged' },
    ]);
    await insertCH('agent_risk', [{ tenant_id: tenant, agent_id: agent, risk_exposure_pct: 0.2, updated_at: '2026-06-10 10:20:00.000' }]);

    // 3. The ROI endpoint returns the finance-grade figures.
    //    value = 120*60/60 = 120 ; fully_loaded = ai 5 + qa 10 = 15
    //    nominal = 120 - 15 = 105 ; risk_adjusted = 120*0.9*(1-0.2) - 15 = 71.4
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/roi')
      .query({ ...WIDE, outcomeType: 'pr_merged', minConfidence: 0 })
      .set(bearer(await tok(tenant, 'viewer')));
    expect(res.status).toBe(200);
    const row = res.body.find((r: { outcome_type: string }) => r.outcome_type === 'pr_merged');
    expect(row).toBeDefined();
    expect(Number(row.value_usd)).toBeCloseTo(120, 5);
    expect(Number(row.fully_loaded_cost_usd)).toBeCloseTo(15, 5);
    expect(Number(row.nominal_roi_usd)).toBeCloseTo(105, 5);
    expect(Number(row.risk_adjusted_roi_usd)).toBeCloseTo(71.4, 3);
    // Risk discount actually bites (risk-adjusted < nominal).
    expect(Number(row.risk_adjusted_roi_usd)).toBeLessThan(Number(row.nominal_roi_usd));

    // 4. Trace the figure back to source events: outcome -> run -> llm_call.
    const tracedRun = await queryCH(
      `SELECT run_id FROM agentledger.v_roi WHERE tenant_id='${tenant}' AND outcome_id='${outcomeId}'`,
    );
    expect(tracedRun).toBe(runId);
    const tracedCall = await queryCH(
      `SELECT call_id, cost_usd FROM agentledger.llm_calls WHERE tenant_id='${tenant}' AND run_id='${runId}'`,
    );
    expect(tracedCall).toBe(`${callId}\t5`);
  });

  it('is tenant-isolated (another tenant sees none of these ROI rows)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/analytics/roi')
      .query({ ...WIDE, minConfidence: 0 })
      .set(bearer(await tok(otherTenant, 'viewer')));
    expect(res.status).toBe(200);
    expect(res.body.every((r: { value_usd: number }) => Number(r.value_usd) !== 120)).toBe(true);
  });
});
