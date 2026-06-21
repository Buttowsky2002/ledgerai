import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * SCIM 2.0 provisioning end to end against a live Postgres (`make e2e`). Exercises
 * the full path: an admin issues a per-tenant SCIM token via the control-plane API,
 * then an "IdP" uses it to provision/deprovision Users and Groups — proving the
 * token → tenant resolution, identity/team mapping, deactivation, the SCIM error
 * envelope, and cross-tenant isolation against the real schema (migration 009).
 */
describe('SCIM 2.0 provisioning', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let scimToken = '';
  const scim = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    process.env.AGENTLEDGER_JWT_SECRET = process.env.AGENTLEDGER_JWT_SECRET ?? 'test-secret';
    process.env.AGENTLEDGER_DEV_TRUST_HEADER = 'false';
    process.env.AGENTLEDGER_PG_DSN =
      process.env.AGENTLEDGER_PG_DSN ??
      'postgres://agentledger_api:dev_only_change_me@localhost:5432/agentledger?sslmode=disable';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    await prisma.withTenant(tenantA, (tx) => tx.tenant.create({ data: { tenantId: tenantA, name: 'Tenant A' } }));
    await prisma.withTenant(tenantB, (tx) => tx.tenant.create({ data: { tenantId: tenantB, name: 'Tenant B' } }));

    // An admin issues a SCIM token for tenant A through the control-plane API.
    const adminA = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenantA, role: 'admin' });
    const issued = await scim().post('/v1/scim-tokens').set(bearer(adminA)).send({ name: 'Okta prod' });
    expect(issued.status).toBe(201);
    expect(issued.body.scimToken.tokenHash).toBeUndefined(); // never leaked
    scimToken = issued.body.token;
    expect(scimToken).toMatch(/^scim_/);
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await prisma.withTenant(t, async (tx) => {
        await tx.identity.deleteMany({});
        await tx.team.deleteMany({});
        await tx.scimToken.deleteMany({});
        await tx.tenant.deleteMany({});
      });
    }
    await app.close();
  });

  it('rejects an unknown SCIM token (401, SCIM error envelope)', async () => {
    const res = await scim().get('/scim/v2/Users').set(bearer('scim_bogus'));
    expect(res.status).toBe(401);
    expect(res.body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
  });

  let userId = '';

  it('provisions a User (POST /Users) → identity with source=scim', async () => {
    const res = await scim()
      .post('/scim/v2/Users')
      .set(bearer(scimToken))
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'Alice@Acme.com',
        externalId: 'okta-alice',
        name: { formatted: 'Alice A' },
        active: true,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userName: 'alice@acme.com', externalId: 'okta-alice', active: true });
    userId = res.body.id;

    const row = await prisma.withTenant(tenantA, (tx) => tx.identity.findUnique({ where: { userId } }));
    expect(row).toMatchObject({ source: 'scim', externalId: 'okta-alice', active: true });
  });

  it('finds the user by userName filter (ListResponse)', async () => {
    const res = await scim()
      .get('/scim/v2/Users')
      .query({ filter: 'userName eq "alice@acme.com"' })
      .set(bearer(scimToken));
    expect(res.status).toBe(200);
    expect(res.body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:ListResponse');
    expect(res.body.totalResults).toBe(1);
    expect(res.body.Resources[0].id).toBe(userId);
  });

  it('rejects a duplicate userName (409 uniqueness)', async () => {
    const res = await scim()
      .post('/scim/v2/Users')
      .set(bearer(scimToken))
      .send({ userName: 'alice@acme.com' });
    expect(res.status).toBe(409);
    expect(res.body.scimType).toBe('uniqueness');
  });

  it('deactivates the user via PATCH active=false', async () => {
    const res = await scim()
      .patch(`/scim/v2/Users/${userId}`)
      .set(bearer(scimToken))
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    // active=false is exactly what D1's login path refuses (auth_lookup_identity filters active).
    const row = await prisma.withTenant(tenantA, (tx) => tx.identity.findUnique({ where: { userId } }));
    expect(row?.active).toBe(false);
  });

  it('rejects a malformed PATCH (400, SCIM error)', async () => {
    const res = await scim()
      .patch(`/scim/v2/Users/${userId}`)
      .set(bearer(scimToken))
      .send({ not: 'a patchop' });
    expect(res.status).toBe(400);
    expect(res.body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
  });

  it('provisions a Group (→ team) and assigns membership', async () => {
    const res = await scim()
      .post('/scim/v2/Groups')
      .set(bearer(scimToken))
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Engineering',
        externalId: 'okta-grp-eng',
        members: [{ value: userId }],
      });
    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe('Engineering');
    expect(res.body.members.map((m: { value: string }) => m.value)).toContain(userId);

    const row = await prisma.withTenant(tenantA, (tx) => tx.identity.findUnique({ where: { userId } }));
    expect(row?.teamId).toBe(res.body.id); // membership set the primary team
  });

  it('isolates tenants: A token cannot read B users (404)', async () => {
    const bUser = await prisma.withTenant(tenantB, (tx) =>
      tx.identity.create({ data: { tenantId: tenantB, email: 'bob@tenant-b.com', source: 'scim' } }),
    );
    const res = await scim().get(`/scim/v2/Users/${bUser.userId}`).set(bearer(scimToken));
    expect(res.status).toBe(404); // RLS hides it; SCIM reports not-found
    expect(res.body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
  });
});
