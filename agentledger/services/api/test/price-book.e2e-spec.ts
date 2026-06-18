import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';

/** Price book is global (no tenant, no RLS); reads = viewer, writes = admin. */
describe('Price book (global, admin-write)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const tenant = randomUUID();
  const marker = `test-${randomUUID()}`; // unique source tag for cleanup
  let admin: string;
  let viewer: string;

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
    admin = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role: 'admin' });
    viewer = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role: 'viewer' });
  });

  afterAll(async () => {
    await prisma.withTenant(tenant, async (tx) => {
      await tx.priceBook.deleteMany({ where: { source: marker } });
      await tx.auditLog.deleteMany({});
    });
    await app.close();
  });

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const price = () => ({
    provider: 'openai',
    modelPrefix: 'gpt-4o',
    tokenType: 'input',
    usdPerMillion: 2.5,
    source: marker,
    effectiveStart: '2026-01-01T00:00:00.000Z',
  });

  it('viewer can read, cannot write', async () => {
    expect((await request(app.getHttpServer()).get('/v1/price-book').set(bearer(viewer))).status).toBe(200);
    const res = await request(app.getHttpServer()).post('/v1/price-book').set(bearer(viewer)).send(price());
    expect(res.status).toBe(403);
  });

  it('admin can create/update/delete a global price row', async () => {
    const created = await request(app.getHttpServer()).post('/v1/price-book').set(bearer(admin)).send(price());
    expect(created.status).toBe(201);
    const id = created.body.priceId;
    expect(id).toBeDefined();

    const upd = await request(app.getHttpServer())
      .patch(`/v1/price-book/${id}`)
      .set(bearer(admin))
      .send({ usdPerMillion: 3.0 });
    expect(upd.status).toBe(200);

    const del = await request(app.getHttpServer()).delete(`/v1/price-book/${id}`).set(bearer(admin));
    expect(del.status).toBe(200);
  });
});
