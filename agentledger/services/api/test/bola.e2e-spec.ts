import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * BOLA (OWASP API1): tenant A creates resources; tenant B must get 404 (not 200/403)
 * on ID-parameterised high-value routes. Requires live Postgres (`make e2e`).
 */
describe('BOLA — cross-tenant ID access fails closed (404)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let adminA: string;
  let adminB: string;

  beforeAll(async () => {
    process.env.AGENTLEDGER_JWT_SECRET = process.env.AGENTLEDGER_JWT_SECRET ?? 'test-secret';
    process.env.AGENTLEDGER_DEV_TRUST_HEADER = 'false';
    process.env.AGENTLEDGER_PG_DSN =
      process.env.AGENTLEDGER_PG_DSN ??
      'postgres://agentledger_api:dev_only_change_me@localhost:5432/agentledger?sslmode=disable';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    await prisma.withTenant(tenantA, (tx) =>
      tx.tenant.create({ data: { tenantId: tenantA, name: 'bola-A' } }),
    );
    await prisma.withTenant(tenantB, (tx) =>
      tx.tenant.create({ data: { tenantId: tenantB, name: 'bola-B' } }),
    );

    adminA = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenantA, role: 'admin' });
    adminB = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenantB, role: 'admin' });
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await prisma.withTenant(t, async (tx) => {
        await tx.virtualKey.deleteMany({});
        await tx.budget.deleteMany({});
        await tx.connector.deleteMany({});
        await tx.aiProviderConnection.deleteMany({});
        await tx.auditLog.deleteMany({});
        await tx.tenant.deleteMany({});
      });
    }
    await app.close();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const srv = () => app.getHttpServer();

  it('virtual-keys: cross-tenant GET/PATCH/DELETE → 404', async () => {
    const created = await request(srv())
      .post('/v1/virtual-keys')
      .set(auth(adminA))
      .send({ name: `bola-vk-${tenantA.slice(0, 6)}` })
      .expect(201);
    const id = created.body.keyId as string;

    await request(srv()).get(`/v1/virtual-keys/${id}`).set(auth(adminB)).expect(404);
    await request(srv())
      .patch(`/v1/virtual-keys/${id}`)
      .set(auth(adminB))
      .send({ name: 'stolen' })
      .expect(404);
    await request(srv()).delete(`/v1/virtual-keys/${id}`).set(auth(adminB)).expect(404);

    // Owner can still read.
    await request(srv()).get(`/v1/virtual-keys/${id}`).set(auth(adminA)).expect(200);
  });

  it('budgets: cross-tenant GET/PATCH/DELETE → 404', async () => {
    const created = await request(srv())
      .post('/v1/budgets')
      .set(auth(adminA))
      .send({ scopeType: 'tenant', scopeId: tenantA, amountUsd: 100, period: 'monthly' })
      .expect(201);
    const id = created.body.budgetId as string;

    await request(srv()).get(`/v1/budgets/${id}`).set(auth(adminB)).expect(404);
    await request(srv())
      .patch(`/v1/budgets/${id}`)
      .set(auth(adminB))
      .send({ amountUsd: 1 })
      .expect(404);
    await request(srv()).delete(`/v1/budgets/${id}`).set(auth(adminB)).expect(404);
  });

  it('connectors: cross-tenant GET/PATCH/DELETE → 404', async () => {
    const created = await request(srv())
      .post('/v1/connectors')
      .set(auth(adminA))
      .send({
        displayName: `bola-conn-${tenantA.slice(0, 6)}`,
        provider: 'openai',
        category: 'usage',
        configJson: { baseUrl: 'https://api.openai.com' },
        enabled: false,
      })
      .expect(201);
    const id = created.body.connectorId as string;

    await request(srv()).get(`/v1/connectors/${id}`).set(auth(adminB)).expect(404);
    await request(srv())
      .patch(`/v1/connectors/${id}`)
      .set(auth(adminB))
      .send({ displayName: 'stolen' })
      .expect(404);
    await request(srv()).delete(`/v1/connectors/${id}`).set(auth(adminB)).expect(404);
  });

  it('github-copilot connections: cross-tenant GET/sync → 404', async () => {
    // Seed a connection row directly (create API needs a live GitHub token).
    const connectionId = randomUUID();
    const connectorId = randomUUID();
    await prisma.withTenant(tenantA, async (tx) => {
      await tx.connector.create({
        data: {
          connectorId,
          tenantId: tenantA,
          kind: 'github-copilot-business',
          displayName: 'bola-copilot',
          provider: 'github_copilot_business',
          category: 'license_usage_roi',
          config: {},
          status: 'connected',
          enabled: true,
        },
      });
      await tx.aiProviderConnection.create({
        data: {
          connectionId,
          tenantId: tenantA,
          connectorId,
          provider: 'github_copilot_business',
          connectionType: 'license_usage_roi',
          orgSlug: `bola-org-${tenantA.slice(0, 8)}`,
          displayName: 'bola-copilot',
          roiAssumptions: {},
          scheduleJson: { intervalMinutes: 60, enabled: false },
        },
      });
    });

    await request(srv())
      .get(`/v1/github-copilot/connections/${connectionId}`)
      .set(auth(adminB))
      .expect(404);
    await request(srv())
      .post(`/v1/github-copilot/connections/${connectionId}/sync`)
      .set(auth(adminB))
      .expect(404);
  });
});
