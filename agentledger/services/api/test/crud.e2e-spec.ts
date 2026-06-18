import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Generic CRUD + audit + RBAC, exercised over /v1/teams. Requires a live Postgres
 * (`make e2e`). Mirrors main.ts's global ValidationPipe so the unknown-field case
 * is exercised.
 */
describe('CRUD + audit + RBAC (teams)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let adminA: string;
  let viewerA: string;
  let adminB: string;

  beforeAll(async () => {
    process.env.AGENTLEDGER_JWT_SECRET = process.env.AGENTLEDGER_JWT_SECRET ?? 'test-secret';
    process.env.AGENTLEDGER_DEV_TRUST_HEADER = 'false';
    process.env.AGENTLEDGER_PG_DSN =
      process.env.AGENTLEDGER_PG_DSN ??
      'postgres://agentledger_api:dev_only_change_me@localhost:5432/agentledger?sslmode=disable';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    // Teams FK → tenants, so the tenant rows must exist first.
    await prisma.withTenant(tenantA, (tx) => tx.tenant.create({ data: { tenantId: tenantA, name: 'A' } }));
    await prisma.withTenant(tenantB, (tx) => tx.tenant.create({ data: { tenantId: tenantB, name: 'B' } }));

    adminA = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenantA, role: 'admin' });
    viewerA = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenantA, role: 'viewer' });
    adminB = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenantB, role: 'admin' });
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await prisma.withTenant(t, async (tx) => {
        await tx.team.deleteMany({});
        await tx.auditLog.deleteMany({});
        await tx.tenant.deleteMany({});
      });
    }
    await app.close();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('viewer can read (200), but cannot write (403)', async () => {
    expect((await request(app.getHttpServer()).get('/v1/teams').set(auth(viewerA))).status).toBe(200);
    const create = await request(app.getHttpServer())
      .post('/v1/teams')
      .set(auth(viewerA))
      .send({ name: 'nope' });
    expect(create.status).toBe(403);
  });

  it('admin create writes the row and an audit_log entry (before/after)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/teams')
      .set(auth(adminA))
      .send({ name: `crud-${tenantA.slice(0, 6)}`, costCenter: 'CC-1' });
    expect(res.status).toBe(201);
    const id = res.body.teamId;
    expect(id).toBeDefined();

    const audits = await prisma.withTenant(tenantA, (tx) =>
      tx.auditLog.findMany({ where: { object: `team:${id}` } }),
    );
    expect(audits.length).toBe(1);
    expect(audits[0].action).toBe('create');
    expect((audits[0].detail as { after: { name: string } }).after.name).toContain('crud-');
  });

  it('rejects unknown fields (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/teams')
      .set(auth(adminA))
      .send({ name: 'x', bogusField: 'y' });
    expect(res.status).toBe(400);
  });

  it('update captures before+after in the audit log', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/teams')
      .set(auth(adminA))
      .send({ name: `upd-${tenantA.slice(0, 6)}`, costCenter: 'CC-old' });
    const id = created.body.teamId;
    const upd = await request(app.getHttpServer())
      .patch(`/v1/teams/${id}`)
      .set(auth(adminA))
      .send({ costCenter: 'CC-new' });
    expect(upd.status).toBe(200);
    const audits = await prisma.withTenant(tenantA, (tx) =>
      tx.auditLog.findMany({ where: { object: `team:${id}`, action: 'update' } }),
    );
    expect(audits.length).toBe(1);
    const detail = audits[0].detail as { before: { costCenter: string }; after: { costCenter: string } };
    expect(detail.before.costCenter).toBe('CC-old');
    expect(detail.after.costCenter).toBe('CC-new');
  });

  it('cross-tenant access fails closed (404)', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/teams')
      .set(auth(adminA))
      .send({ name: `xt-${tenantA.slice(0, 6)}` });
    const id = created.body.teamId;
    // Tenant B admin cannot see tenant A's team.
    expect((await request(app.getHttpServer()).get(`/v1/teams/${id}`).set(auth(adminB))).status).toBe(404);
    expect(
      (await request(app.getHttpServer()).patch(`/v1/teams/${id}`).set(auth(adminB)).send({ name: 'hijack' })).status,
    ).toBe(404);
    expect((await request(app.getHttpServer()).delete(`/v1/teams/${id}`).set(auth(adminB))).status).toBe(404);
  });
});
