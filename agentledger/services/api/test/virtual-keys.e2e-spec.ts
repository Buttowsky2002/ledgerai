import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

describe('Virtual keys', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const tenant = randomUUID();
  let admin: string;

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
    await prisma.withTenant(tenant, (tx) => tx.tenant.create({ data: { tenantId: tenant, name: 'K' } }));
    admin = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role: 'admin' });
  });

  afterAll(async () => {
    await prisma.withTenant(tenant, async (tx) => {
      await tx.virtualKey.deleteMany({});
      await tx.auditLog.deleteMany({});
      await tx.tenant.deleteMany({});
    });
    await app.close();
  });

  it('mints a plaintext alk_ key once; stores only its sha256 hash', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/virtual-keys')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: 'svc-key' });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^alk_[0-9a-f]{48}$/);
    expect(res.body.keyHash).toBeUndefined();

    const row = await prisma.withTenant(tenant, (tx) =>
      tx.virtualKey.findUnique({ where: { keyId: res.body.keyId } }),
    );
    // Stored hash matches sha256hex(plaintext) — gateway-compatible.
    expect(row?.keyHash).toBe(sha256hex(res.body.key));
  });

  it('never exposes the hash on list or get', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/virtual-keys')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: 'svc-key-2' });
    const list = await request(app.getHttpServer())
      .get('/v1/virtual-keys')
      .set('Authorization', `Bearer ${admin}`);
    expect(list.status).toBe(200);
    for (const k of list.body) {
      expect(k.keyHash).toBeUndefined();
      expect(k.key).toBeUndefined();
    }
    const get = await request(app.getHttpServer())
      .get(`/v1/virtual-keys/${created.body.keyId}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(get.body.keyHash).toBeUndefined();
  });

  it('revoke (DELETE) sets revoked_at', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/virtual-keys')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: 'svc-key-3' });
    const del = await request(app.getHttpServer())
      .delete(`/v1/virtual-keys/${created.body.keyId}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(200);
    const row = await prisma.withTenant(tenant, (tx) =>
      tx.virtualKey.findUnique({ where: { keyId: created.body.keyId } }),
    );
    expect(row?.revokedAt).not.toBeNull();
  });

  it('requires admin to mint (viewer → 403)', async () => {
    const viewer = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenant, role: 'viewer' });
    const res = await request(app.getHttpServer())
      .post('/v1/virtual-keys')
      .set('Authorization', `Bearer ${viewer}`)
      .send({ name: 'denied' });
    expect(res.status).toBe(403);
  });
});
