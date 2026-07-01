import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtService } from '../src/auth/jwt.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * ROI-template CRUD + audit + RBAC + RLS over /v1/roi-templates. Requires a live
 * Postgres (`make e2e`). Mirrors crud.e2e-spec.ts and the global ValidationPipe so
 * the malformed-JSONB and unknown-field cases are exercised.
 */
describe('ROI templates CRUD (api)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let adminA: string;
  let viewerA: string;
  let adminB: string;

  const validTemplate = () => ({
    name: `roi-${tenantA.slice(0, 6)}`,
    outcomeType: 'ticket_resolved',
    sourceSystem: 'zendesk',
    valueFormula: { hourly_rate: 120, baseline_minutes: 30, rework_pct: 0.15 },
    attribution: { window_minutes: 240, match_on: ['user', 'issue'] },
  });

  beforeAll(async () => {
    process.env.BADGERIQ_JWT_SECRET = process.env.BADGERIQ_JWT_SECRET ?? 'test-secret';
    process.env.BADGERIQ_DEV_TRUST_HEADER = 'false';
    process.env.BADGERIQ_PG_DSN =
      process.env.BADGERIQ_PG_DSN ??
      'postgres://agentledger_api:dev_only_change_me@localhost:5432/agentledger?sslmode=disable';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    // roi_templates.tenant_id FK → tenants, so the tenant rows must exist first.
    await prisma.withTenant(tenantA, (tx) => tx.tenant.create({ data: { tenantId: tenantA, name: 'A' } }));
    await prisma.withTenant(tenantB, (tx) => tx.tenant.create({ data: { tenantId: tenantB, name: 'B' } }));

    adminA = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenantA, role: 'admin' });
    viewerA = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenantA, role: 'viewer' });
    adminB = await jwt.mintAccess({ userId: randomUUID(), tenantId: tenantB, role: 'admin' });
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await prisma.withTenant(t, async (tx) => {
        await tx.roiTemplate.deleteMany({});
        await tx.auditLog.deleteMany({});
        await tx.tenant.deleteMany({});
      });
    }
    await app.close();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('viewer can read (200), but cannot write (403)', async () => {
    expect((await request(app.getHttpServer()).get('/v1/roi-templates').set(auth(viewerA))).status).toBe(200);
    const create = await request(app.getHttpServer())
      .post('/v1/roi-templates')
      .set(auth(viewerA))
      .send(validTemplate());
    expect(create.status).toBe(403);
  });

  it('admin create writes the row and an audit_log entry (before/after)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/roi-templates')
      .set(auth(adminA))
      .send(validTemplate());
    expect(res.status).toBe(201);
    const id = res.body.templateId;
    expect(id).toBeDefined();
    expect(res.body.valueFormula.hourly_rate).toBe(120);

    const audits = await prisma.withTenant(tenantA, (tx) =>
      tx.auditLog.findMany({ where: { object: `roi_template:${id}` } }),
    );
    expect(audits.length).toBe(1);
    expect(audits[0].action).toBe('create');
    expect((audits[0].detail as { after: { name: string } }).after.name).toContain('roi-');
  });

  it('rejects unknown fields (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/roi-templates')
      .set(auth(adminA))
      .send({ ...validTemplate(), bogusField: 'y' });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed value_formula (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/roi-templates')
      .set(auth(adminA))
      .send({ ...validTemplate(), valueFormula: { hourly_rate: 'not-a-number', baseline_minutes: 30 } });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown outcome_type / match_on value (400)', async () => {
    const badType = await request(app.getHttpServer())
      .post('/v1/roi-templates')
      .set(auth(adminA))
      .send({ ...validTemplate(), outcomeType: 'invoice_processed' });
    expect(badType.status).toBe(400);

    const badMatch = await request(app.getHttpServer())
      .post('/v1/roi-templates')
      .set(auth(adminA))
      .send({ ...validTemplate(), attribution: { match_on: ['repo'] } });
    expect(badMatch.status).toBe(400);
  });

  it('update captures before+after in the audit log', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/roi-templates')
      .set(auth(adminA))
      .send(validTemplate());
    const id = created.body.templateId;
    const upd = await request(app.getHttpServer())
      .patch(`/v1/roi-templates/${id}`)
      .set(auth(adminA))
      .send({ name: 'renamed' });
    expect(upd.status).toBe(200);
    const audits = await prisma.withTenant(tenantA, (tx) =>
      tx.auditLog.findMany({ where: { object: `roi_template:${id}`, action: 'update' } }),
    );
    expect(audits.length).toBe(1);
    const detail = audits[0].detail as { before: { name: string }; after: { name: string } };
    expect(detail.after.name).toBe('renamed');
  });

  it('cross-tenant access fails closed (404)', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/roi-templates')
      .set(auth(adminA))
      .send(validTemplate());
    const id = created.body.templateId;
    expect((await request(app.getHttpServer()).get(`/v1/roi-templates/${id}`).set(auth(adminB))).status).toBe(404);
    expect(
      (await request(app.getHttpServer()).patch(`/v1/roi-templates/${id}`).set(auth(adminB)).send({ name: 'hijack' })).status,
    ).toBe(404);
    expect((await request(app.getHttpServer()).delete(`/v1/roi-templates/${id}`).set(auth(adminB))).status).toBe(404);
  });
});
