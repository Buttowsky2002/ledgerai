import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Auth + RBAC end to end. Uses test-minted JWTs (signed with the same
 * AGENTLEDGER_JWT_SECRET) — live OIDC needs provider credentials we don't have,
 * so the openid-client exchange isn't exercised here; the JWT/guard/RBAC paths
 * (which is what task 2 enforces) are. Requires a live Postgres (`make e2e`).
 */
describe('Auth + RBAC', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const tenantA = randomUUID();
  const teamName = `team-${tenantA.slice(0, 8)}`;
  const secret = () => new TextEncoder().encode(process.env.AGENTLEDGER_JWT_SECRET);

  beforeAll(async () => {
    process.env.AGENTLEDGER_JWT_SECRET = process.env.AGENTLEDGER_JWT_SECRET ?? 'test-secret';
    process.env.AGENTLEDGER_DEV_TRUST_HEADER = 'false'; // pure JWT auth here
    process.env.AGENTLEDGER_PG_DSN =
      process.env.AGENTLEDGER_PG_DSN ??
      'postgres://agentledger_api:dev_only_change_me@localhost:5432/agentledger?sslmode=disable';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser()); // mirror main.ts so /auth/refresh can read the cookie
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    await prisma.withTenant(tenantA, async (tx) => {
      await tx.tenant.create({ data: { tenantId: tenantA, name: 'Tenant A' } });
      await tx.team.create({ data: { tenantId: tenantA, name: teamName } });
    });
  });

  afterAll(async () => {
    await prisma.withTenant(tenantA, async (tx) => {
      await tx.team.deleteMany({});
      await tx.tenant.deleteMany({});
    });
    await app.close();
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('rejects an unauthenticated request (401)', async () => {
    const res = await request(app.getHttpServer()).get('/v1/teams');
    expect(res.status).toBe(401);
  });

  it('allows an analyst+ token and scopes to its tenant', async () => {
    const token = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenantA, role: 'analyst' });
    const res = await request(app.getHttpServer()).get('/v1/teams').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.map((t: { name: string }) => t.name)).toEqual([teamName]);
  });

  it('forbids a viewer on an admin-gated write (403)', async () => {
    // Reads are viewer+; writes are admin-only (task 3). A viewer POST is forbidden.
    const token = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenantA, role: 'viewer' });
    const res = await request(app.getHttpServer())
      .post('/v1/teams')
      .set(bearer(token))
      .send({ name: 'denied' });
    expect(res.status).toBe(403);
  });

  it('rejects an expired access token (401)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ tid: tenantA, role: 'admin', typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(randomUUID())
      .setIssuer('agentledger')
      .setAudience('agentledger-api')
      .setIssuedAt(now - 3600)
      .setExpirationTime(now - 1800)
      .sign(secret());
    const res = await request(app.getHttpServer()).get('/v1/teams').set(bearer(expired));
    expect(res.status).toBe(401);
  });

  it('rejects a refresh token presented as an access token (401)', async () => {
    const refresh = await jwt.mintRefresh({ userId: randomUUID(), tenantId: tenantA, role: 'admin' });
    const res = await request(app.getHttpServer()).get('/v1/teams').set(bearer(refresh));
    expect(res.status).toBe(401);
  });

  it('GET /auth/me returns the principal', async () => {
    const userId = randomUUID();
    const token = await jwt.mintAccess({ userId, tenantId: tenantA, role: 'admin' });
    const res = await request(app.getHttpServer()).get('/auth/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId, tenantId: tenantA, role: 'admin' });
  });

  it('POST /auth/refresh mints a fresh access token from the refresh cookie', async () => {
    const refresh = await jwt.mintRefresh({ userId: randomUUID(), tenantId: tenantA, role: 'analyst' });
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', `al_refresh=${refresh}`);
    expect(res.status).toBe(200); // @Res() + res.json() → Express default 200
    expect(res.body.access_token).toBeDefined();
    // The minted access token works on a protected route.
    const probe = await request(app.getHttpServer()).get('/auth/me').set(bearer(res.body.access_token));
    expect(probe.status).toBe(200);
  });

  it('rate-limits auth endpoints (429 after the per-minute cap)', async () => {
    let saw429 = false;
    for (let i = 0; i < 15; i++) {
      const res = await request(app.getHttpServer()).post('/auth/logout');
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});
