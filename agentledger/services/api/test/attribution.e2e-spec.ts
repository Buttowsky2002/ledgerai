import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Cross-tenant attribution-read isolation — the permanent §7 acceptance test for
 * the attribution moat. Proves a request scoped to tenant A can never read tenant
 * B's attribution_edges, even for the SAME outcome_id, by RLS (deploy/postgres/010).
 *
 * The API connects as the non-superuser agentledger_api role, which has SELECT-only
 * on attribution_edges (the worker owns writes — migration 010). So the edges are
 * SEEDED through a separate superuser connection (as the worker would), then read
 * back through the RLS-scoped API. Requires `make e2e` (live Postgres + dev role).
 */
describe('Attribution audit (RLS)', () => {
  let app: INestApplication;
  let seed: PrismaClient;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const outcome = 'github:acme/shared#1'; // SAME id for both tenants — must stay isolated
  const SEED_DSN =
    process.env.AGENTLEDGER_SEED_DSN ??
    'postgres://agentledger:dev_only_change_me@localhost:5432/agentledger?sslmode=disable';
  const contribs = JSON.stringify([
    { signal: 'temporal_proximity', signal_type: 'temporal', value: 0.8, weighted_log_odds: 1.9, evidence_ref: 'gap=12m' },
  ]);

  beforeAll(async () => {
    process.env.AGENTLEDGER_DEV_TRUST_HEADER = 'true';
    process.env.AGENTLEDGER_JWT_SECRET = process.env.AGENTLEDGER_JWT_SECRET ?? 'test-secret';
    process.env.AGENTLEDGER_PG_DSN =
      process.env.AGENTLEDGER_PG_DSN ??
      'postgres://agentledger_api:dev_only_change_me@localhost:5432/agentledger?sslmode=disable';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    // Seed as the owner/worker role (superuser bypasses RLS, exactly like the worker).
    seed = new PrismaClient({ datasources: { db: { url: SEED_DSN } } });
    await seed.$executeRaw`INSERT INTO tenants (tenant_id, name) VALUES (${tenantA}::uuid, 'A'), (${tenantB}::uuid, 'B')`;
    await seed.$executeRaw`INSERT INTO attribution_model_versions (version, kind, active)
      VALUES ('e2e-scorer', 'scorer', true) ON CONFLICT (version) DO NOTHING`;
    await seed.$executeRaw`INSERT INTO attribution_edges
      (tenant_id, outcome_id, run_id, agent_id, attribution_method, confidence_raw, confidence_calibrated, signal_contributions, model_version)
      VALUES (${tenantA}::uuid, ${outcome}, 'rA', 'agentA', 'probabilistic', 0.75, 0.8, ${contribs}::jsonb, 'e2e-scorer')`;
    await seed.$executeRaw`INSERT INTO attribution_edges
      (tenant_id, outcome_id, run_id, agent_id, attribution_method, confidence_raw, confidence_calibrated, signal_contributions, model_version)
      VALUES (${tenantB}::uuid, ${outcome}, 'rB', 'agentB', 'deterministic', 1.0, 1.0, '[]'::jsonb, 'e2e-scorer')`;
  });

  afterAll(async () => {
    await seed.$executeRaw`DELETE FROM tenants WHERE tenant_id IN (${tenantA}::uuid, ${tenantB}::uuid)`;
    await seed.$disconnect();
    await app.close();
  });

  it('returns only the requesting tenant\'s edge for a shared outcome_id', async () => {
    const a = await request(app.getHttpServer())
      .get(`/v1/attribution/edges?outcomeId=${encodeURIComponent(outcome)}`)
      .set('x-tenant-id', tenantA);
    expect(a.status).toBe(200);
    expect(a.body).toHaveLength(1);
    expect(a.body[0].agent_id).toBe('agentA');
    expect(a.body[0].attribution_method).toBe('probabilistic');
    // The per-signal breakdown (the audit trail) comes back intact.
    expect(a.body[0].signal_contributions[0].signal).toBe('temporal_proximity');

    const b = await request(app.getHttpServer())
      .get(`/v1/attribution/edges?outcomeId=${encodeURIComponent(outcome)}`)
      .set('x-tenant-id', tenantB);
    expect(b.status).toBe(200);
    expect(b.body).toHaveLength(1);
    expect(b.body[0].agent_id).toBe('agentB');
  });

  it('tenant A never sees tenant B\'s edge (RLS fails closed)', async () => {
    const a = await request(app.getHttpServer())
      .get(`/v1/attribution/edges?outcomeId=${encodeURIComponent(outcome)}`)
      .set('x-tenant-id', tenantA);
    const agents = a.body.map((e: { agent_id: string }) => e.agent_id);
    expect(agents).not.toContain('agentB');
  });

  it('honors the confidence floor (A\'s 0.8 edge excluded at minConfidence 0.9)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/attribution/edges?outcomeId=${encodeURIComponent(outcome)}&minConfidence=0.9`)
      .set('x-tenant-id', tenantA);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('fails closed at the API edge: unauthenticated request is rejected (401)', async () => {
    const none = await request(app.getHttpServer()).get('/v1/attribution/edges');
    expect(none.status).toBe(401);
  });
});
