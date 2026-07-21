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
      await tx.identity.deleteMany({});
      await tx.team.deleteMany({});
      await tx.tenant.deleteMany({});
    });
    await app.close();
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  // Set-Cookie helpers: find an entry by name and pull its value.
  const setCookies = (res: request.Response): string[] =>
    (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const findCookie = (res: request.Response, name: string): string | undefined =>
    setCookies(res).find((c) => c.startsWith(`${name}=`));
  const cookieValue = (entry: string): string => entry.split(';')[0].split('=').slice(1).join('=');

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

  it('POST /auth/refresh renews the al_access cookie and returns {ok, expires_in}', async () => {
    // Refresh re-reads api_role from identities — seed a real row (JWT alone is not enough).
    const userId = randomUUID();
    await prisma.withTenant(tenantA, (tx) =>
      tx.identity.create({
        data: {
          userId,
          tenantId: tenantA,
          email: `refresh-${userId.slice(0, 8)}@example.com`,
          apiRole: 'admin',
          source: 'manual',
        },
      }),
    );
    // Stale role in the refresh JWT must be overwritten by the DB value (admin).
    const refresh = await jwt.mintRefresh({ userId, tenantId: tenantA, role: 'analyst' });
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', `al_refresh=${refresh}`);
    expect(res.status).toBe(200); // @Res() + res.json() → Express default 200
    expect(res.body).toMatchObject({ ok: true, expires_in: 15 * 60 });
    expect(res.body.access_token).toBeUndefined(); // token lives only in the httpOnly cookie

    const accessEntry = findCookie(res, 'al_access');
    expect(accessEntry).toBeDefined();
    expect(accessEntry).toMatch(/HttpOnly/i);
    expect(accessEntry).toMatch(/SameSite=Strict/i);
    expect(accessEntry).toMatch(/Path=\//i);

    // The renewed access token (from the cookie) authorizes a protected route with DB role.
    const probe = await request(app.getHttpServer()).get('/auth/me').set(bearer(cookieValue(accessEntry!)));
    expect(probe.status).toBe(200);
    expect(probe.body).toMatchObject({ userId, role: 'admin' });
  });

  it('POST /auth/refresh refuses a token whose identity was deleted (401)', async () => {
    const refresh = await jwt.mintRefresh({
      userId: randomUUID(),
      tenantId: tenantA,
      role: 'analyst',
    });
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', `al_refresh=${refresh}`);
    expect(res.status).toBe(401);
  });

  it('POST /auth/refresh without a refresh cookie is 401', async () => {
    const res = await request(app.getHttpServer()).post('/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('POST /auth/logout clears both al_access and al_refresh', async () => {
    const res = await request(app.getHttpServer()).post('/auth/logout');
    expect(res.status).toBe(204);
    const access = findCookie(res, 'al_access');
    const refresh = findCookie(res, 'al_refresh');
    // Both are cleared: empty value + an expiry in the past.
    expect(access).toMatch(/^al_access=;/);
    expect(refresh).toMatch(/^al_refresh=;/);
    expect(access).toMatch(/Expires=Thu, 01 Jan 1970/i);
    expect(refresh).toMatch(/Expires=Thu, 01 Jan 1970/i);
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
