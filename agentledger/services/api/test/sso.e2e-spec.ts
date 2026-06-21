import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { OidcService } from '../src/auth/oidc.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Enterprise SSO (per-tenant OIDC + JIT) end to end against a live Postgres
 * (`make e2e`). The openid-client exchange needs real provider credentials, so
 * OidcService is overridden to return a fixed verified {email, sub}; everything
 * downstream — domain→IdP resolution, JIT provisioning, deactivation, and
 * cross-tenant isolation — runs against the real schema (migration 008).
 */
describe('Enterprise SSO + JIT', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let verified = { email: 'alice@acme-a.com', sub: 'sub-alice' };

  const oidcStub: Partial<OidcService> = {
    buildTenantAuthRequest: async () => ({
      url: 'https://idp.example/authorize?stub',
      state: 'st',
      nonce: 'no',
      codeVerifier: 'cv',
    }),
    handleTenantCallback: async () => verified,
  };

  beforeAll(async () => {
    process.env.AGENTLEDGER_JWT_SECRET = process.env.AGENTLEDGER_JWT_SECRET ?? 'test-secret';
    process.env.AGENTLEDGER_PG_DSN =
      process.env.AGENTLEDGER_PG_DSN ??
      'postgres://agentledger_api:dev_only_change_me@localhost:5432/agentledger?sslmode=disable';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OidcService)
      .useValue(oidcStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
    prisma = app.get(PrismaService);

    // Two tenants; only tenant A has an IdP, configured for the acme-a.com domain.
    await prisma.withTenant(tenantA, async (tx) => {
      await tx.tenant.create({ data: { tenantId: tenantA, name: 'Tenant A' } });
      await tx.tenantIdpConfig.create({
        data: {
          tenantId: tenantA,
          issuer: 'https://idp.example',
          clientId: 'client-a',
          clientSecretRef: 'STUB_SECRET_ENV',
          emailDomains: ['acme-a.com'],
          jitEnabled: true,
          defaultApiRole: 'analyst',
        },
      });
    });
    await prisma.withTenant(tenantB, async (tx) => {
      await tx.tenant.create({ data: { tenantId: tenantB, name: 'Tenant B' } });
    });
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await prisma.withTenant(t, async (tx) => {
        await tx.identity.deleteMany({});
        await tx.tenantIdpConfig.deleteMany({});
        await tx.tenant.deleteMany({});
      });
    }
    await app.close();
  });

  // Drive /sso/login (to mint the tx cookie) then /sso/callback with that cookie.
  async function ssoLogin(email: string): Promise<request.Response> {
    const login = await request(app.getHttpServer()).get('/auth/sso/login').query({ email });
    const txCookie = (login.headers['set-cookie'] as unknown as string[])?.find((c) =>
      c.startsWith('al_oidc_tx='),
    );
    if (!txCookie) {
      return login; // login failed (e.g. no IdP) — return for assertion
    }
    return request(app.getHttpServer()).get('/auth/sso/callback').set('Cookie', txCookie);
  }

  it('JIT-provisions a new identity on first SSO login', async () => {
    verified = { email: 'alice@acme-a.com', sub: 'sub-alice' };
    const res = await ssoLogin('alice@acme-a.com');
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();

    const rows = await prisma.withTenant(tenantA, (tx) =>
      tx.identity.findMany({ where: { email: 'alice@acme-a.com' } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'oidc', externalId: 'sub-alice', active: true });
  });

  it('logs the same user in again without creating a duplicate', async () => {
    verified = { email: 'alice@acme-a.com', sub: 'sub-alice' };
    const res = await ssoLogin('alice@acme-a.com');
    expect(res.status).toBe(200);
    const rows = await prisma.withTenant(tenantA, (tx) =>
      tx.identity.findMany({ where: { email: 'alice@acme-a.com' } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses login once the identity is deactivated', async () => {
    await prisma.withTenant(tenantA, (tx) =>
      tx.identity.updateMany({ where: { email: 'alice@acme-a.com' }, data: { active: false } }),
    );
    verified = { email: 'alice@acme-a.com', sub: 'sub-alice' };
    const res = await ssoLogin('alice@acme-a.com');
    expect(res.status).toBe(401);
  });

  it('rejects a domain with no configured IdP (401, no provisioning)', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/sso/login')
      .query({ email: 'bob@unknown-domain.com' });
    expect(res.status).toBe(401);
  });

  it('does not provision into another tenant (domain isolation)', async () => {
    // acme-a.com maps only to tenant A — a tenant-B user can never appear there.
    verified = { email: 'carol@acme-a.com', sub: 'sub-carol' };
    const res = await ssoLogin('carol@acme-a.com');
    expect(res.status).toBe(200);
    const inB = await prisma.withTenant(tenantB, (tx) =>
      tx.identity.findMany({ where: { email: 'carol@acme-a.com' } }),
    );
    expect(inB).toHaveLength(0);
    const inA = await prisma.withTenant(tenantA, (tx) =>
      tx.identity.findMany({ where: { email: 'carol@acme-a.com' } }),
    );
    expect(inA).toHaveLength(1);
  });
});
