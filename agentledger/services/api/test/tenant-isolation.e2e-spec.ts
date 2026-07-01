import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Cross-tenant isolation — the permanent security-rule-3 acceptance test.
 *
 * Proves Postgres RLS (deploy/postgres/002_rls.sql) fails closed: a request
 * scoped to tenant A can never read or write tenant B's rows, by any route, and
 * a request with no tenant bound sees nothing. Requires a live Postgres with the
 * non-superuser `agentledger_api` role (see deploy/postgres-dev/); `make e2e`
 * brings it up. The API MUST connect as that role — a superuser bypasses RLS and
 * this test would (correctly) fail to prove anything.
 */
describe('Tenant isolation (RLS)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const teamAName = `team-A-${tenantA.slice(0, 8)}`;
  const teamBName = `team-B-${tenantB.slice(0, 8)}`;

  beforeAll(async () => {
    process.env.BADGERIQ_DEV_TRUST_HEADER = 'true';
    process.env.BADGERIQ_JWT_SECRET = process.env.BADGERIQ_JWT_SECRET ?? 'test-secret';
    process.env.BADGERIQ_PG_DSN =
      process.env.BADGERIQ_PG_DSN ??
      'postgres://agentledger_api:dev_only_change_me@localhost:5432/agentledger?sslmode=disable';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    // Seed each tenant's data THROUGH the RLS path — this also proves the
    // WITH CHECK side: you can only insert rows for the tenant you're bound to.
    await prisma.withTenant(tenantA, async (tx) => {
      await tx.tenant.create({ data: { tenantId: tenantA, name: 'Tenant A' } });
      await tx.team.create({ data: { tenantId: tenantA, name: teamAName } });
    });
    await prisma.withTenant(tenantB, async (tx) => {
      await tx.tenant.create({ data: { tenantId: tenantB, name: 'Tenant B' } });
      await tx.team.create({ data: { tenantId: tenantB, name: teamBName } });
    });
  });

  afterAll(async () => {
    // Clean up via the RLS path (each tenant deletes only its own rows).
    await prisma.withTenant(tenantA, async (tx) => {
      await tx.team.deleteMany({});
      await tx.tenant.deleteMany({});
    });
    await prisma.withTenant(tenantB, async (tx) => {
      await tx.team.deleteMany({});
      await tx.tenant.deleteMany({});
    });
    await app.close();
  });

  it('scopes GET /v1/teams to the requesting tenant', async () => {
    const a = await request(app.getHttpServer()).get('/v1/teams').set('x-tenant-id', tenantA);
    expect(a.status).toBe(200);
    expect(a.body.map((t: { name: string }) => t.name)).toEqual([teamAName]);

    const b = await request(app.getHttpServer()).get('/v1/teams').set('x-tenant-id', tenantB);
    expect(b.status).toBe(200);
    expect(b.body.map((t: { name: string }) => t.name)).toEqual([teamBName]);
  });

  it('tenant A cannot see tenant B by any route', async () => {
    const a = await request(app.getHttpServer()).get('/v1/teams').set('x-tenant-id', tenantA);
    const names = a.body.map((t: { name: string }) => t.name);
    expect(names).not.toContain(teamBName);
  });

  it('fails closed at the API edge: unauthenticated request is rejected (401)', async () => {
    // Task 2: a global AuthGuard now rejects requests with no principal (previously
    // this returned 200/[]). Auth fails closed before any handler runs.
    const none = await request(app.getHttpServer()).get('/v1/teams');
    expect(none.status).toBe(401);
  });

  it('fails closed at the DB: a query with no tenant bound returns zero rows (RLS)', async () => {
    const rows = await prisma.withTenant(null, (tx) => tx.team.findMany());
    expect(rows).toEqual([]);
  });

  it('does not leak tenant context across pooled connections (A then B, repeated)', async () => {
    // Hammer the same pool alternating tenants; each response must be pure.
    for (let i = 0; i < 8; i++) {
      const tenant = i % 2 === 0 ? tenantA : tenantB;
      const expected = i % 2 === 0 ? teamAName : teamBName;
      const res = await request(app.getHttpServer()).get('/v1/teams').set('x-tenant-id', tenant);
      expect(res.body.map((t: { name: string }) => t.name)).toEqual([expected]);
    }
  });

  it('blocks cross-tenant writes (WITH CHECK): A cannot insert a row for B', async () => {
    await expect(
      prisma.withTenant(tenantA, async (tx) => {
        await tx.team.create({ data: { tenantId: tenantB, name: `evil-${randomUUID()}` } });
      }),
    ).rejects.toThrow();
  });
});
