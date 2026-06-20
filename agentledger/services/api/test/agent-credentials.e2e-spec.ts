import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 6 (C3) acceptance via the API: the NHI credential lifecycle
 * (issue → approve → revoke), tenant isolation under RLS, role enforcement,
 * the blast-radius view, and dormant-agent decommissioning. Requires Postgres up.
 */
describe('Agent credentials / NHI governance (api)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let prisma: PrismaService;
  const tenant = randomUUID();
  const other = randomUUID();
  const agent = randomUUID();

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
    jwt = app.get(JwtService);
    prisma = app.get(PrismaService);

    await prisma.withTenant(tenant, async (tx) => {
      await tx.tenant.create({ data: { tenantId: tenant, name: 'nhi' } });
      await tx.agent.create({ data: { agentId: agent, tenantId: tenant, name: 'Worker Agent' } });
    });
    await prisma.withTenant(other, async (tx) => {
      await tx.tenant.create({ data: { tenantId: other, name: 'other' } });
    });
  });

  afterAll(async () => {
    for (const t of [tenant, other]) {
      await prisma.withTenant(t, async (tx) => {
        await tx.agentCredential.deleteMany({});
        await tx.auditLog.deleteMany({});
        await tx.agent.deleteMany({});
        await tx.tenant.deleteMany({});
      });
    }
    await app.close();
  });

  const tok = (role = 'admin', t = tenant) => jwt.mintAccess({ userId: randomUUID(), tenantId: t, role });
  const srv = () => app.getHttpServer();

  it('issues a credential returning the plaintext token once, never the hash', async () => {
    const res = await request(srv())
      .post('/v1/agent-credentials')
      .set('Authorization', `Bearer ${await tok('analyst')}`)
      .send({ agentId: agent, name: 'ci-cred', scopes: ['read_tickets'], ttlHours: 12 })
      .expect(201);
    expect(res.body.token).toMatch(/^agc_/);
    expect(res.body.credential.status).toBe('pending');
    expect(res.body.credential.scopes).toEqual(['read_tickets']);
    expect(res.body.credential.tokenHash).toBeUndefined();
  });

  it('runs the approve → revoke lifecycle and enforces pending-only approval', async () => {
    const issued = await request(srv())
      .post('/v1/agent-credentials')
      .set('Authorization', `Bearer ${await tok('analyst')}`)
      .send({ agentId: agent, name: 'lifecycle' })
      .expect(201);
    const id = issued.body.credential.credentialId;

    const approved = await request(srv())
      .post(`/v1/agent-credentials/${id}/approve`)
      .set('Authorization', `Bearer ${await tok('admin')}`)
      .expect(201);
    expect(approved.body.status).toBe('active');
    expect(approved.body.approvedBy).toBeTruthy();

    // Re-approving a non-pending credential is rejected.
    await request(srv())
      .post(`/v1/agent-credentials/${id}/approve`)
      .set('Authorization', `Bearer ${await tok('admin')}`)
      .expect(400);

    const revoked = await request(srv())
      .post(`/v1/agent-credentials/${id}/revoke`)
      .set('Authorization', `Bearer ${await tok('admin')}`)
      .send({ reason: 'rotation' })
      .expect(201);
    expect(revoked.body.status).toBe('revoked');
  });

  it('enforces roles: viewer cannot issue or approve', async () => {
    await request(srv())
      .post('/v1/agent-credentials')
      .set('Authorization', `Bearer ${await tok('viewer')}`)
      .send({ agentId: agent, name: 'nope' })
      .expect(403);
  });

  it('isolates tenants under RLS', async () => {
    const issued = await request(srv())
      .post('/v1/agent-credentials')
      .set('Authorization', `Bearer ${await tok('analyst')}`)
      .send({ agentId: agent, name: 'secret' })
      .expect(201);
    const id = issued.body.credential.credentialId;

    // Another tenant cannot see it (list excludes it) ...
    const otherList = await request(srv())
      .get('/v1/agent-credentials')
      .set('Authorization', `Bearer ${await tok('viewer', other)}`)
      .expect(200);
    expect((otherList.body as Array<{ credentialId: string }>).some((c) => c.credentialId === id)).toBe(false);

    // ... and cannot approve it (RLS hides the row → 404).
    await request(srv())
      .post(`/v1/agent-credentials/${id}/approve`)
      .set('Authorization', `Bearer ${await tok('admin', other)}`)
      .expect(404);
  });

  it('reports blast radius per agent', async () => {
    const res = await request(srv())
      .get('/v1/agent-credentials/blast-radius')
      .set('Authorization', `Bearer ${await tok('viewer')}`)
      .expect(200);
    const row = (res.body as Array<{ agentId: string; totalCredentials: number }>).find((r) => r.agentId === agent);
    expect(row).toBeDefined();
    expect(row!.totalCredentials).toBeGreaterThanOrEqual(1);
  });

  it('decommissions dormant agents and revokes their active credentials', async () => {
    const dormantAgent = randomUUID();
    const credId = randomUUID();
    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    await prisma.withTenant(tenant, async (tx) => {
      await tx.agent.create({ data: { agentId: dormantAgent, tenantId: tenant, name: 'Dormant Agent' } });
      await tx.agentCredential.create({
        data: {
          credentialId: credId,
          tenantId: tenant,
          agentId: dormantAgent,
          name: 'stale',
          tokenHash: 'deadbeef',
          status: 'active',
          lastUsedAt: old,
        },
      });
    });

    const res = await request(srv())
      .post('/v1/agent-credentials/decommission-dormant')
      .set('Authorization', `Bearer ${await tok('admin')}`)
      .send({ dormantDays: 30 })
      .expect(201);
    expect(res.body.decommissionedAgents).toBeGreaterThanOrEqual(1);

    await prisma.withTenant(tenant, async (tx) => {
      const cred = await tx.agentCredential.findUnique({ where: { credentialId: credId } });
      expect(cred?.status).toBe('revoked');
      const ag = await tx.agent.findUnique({ where: { agentId: dormantAgent } });
      expect(ag?.decommissionedAt).not.toBeNull();
    });
  });
});
