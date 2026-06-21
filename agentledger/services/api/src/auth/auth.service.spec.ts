import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { JwtService } from './jwt.service';

/**
 * Unit coverage for the SSO provisioning logic (P6-D1) — no database. PrismaService
 * is mocked: $queryRaw returns canned function-call results in sequence, withTenant
 * runs the callback against a fake transaction so the JIT audit write is observable.
 * JwtService is real (deterministic HS256), so minted tokens are genuine.
 */
describe('AuthService SSO', () => {
  let svc: AuthService;
  let queryRaw: jest.Mock;
  let auditCreate: jest.Mock;

  const TENANT = '11111111-1111-1111-1111-111111111111';

  beforeAll(() => {
    process.env.AGENTLEDGER_JWT_SECRET = process.env.AGENTLEDGER_JWT_SECRET ?? 'test-secret';
  });

  beforeEach(() => {
    queryRaw = jest.fn();
    auditCreate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      $queryRaw: queryRaw,
      withTenant: jest.fn(async (_tenantId: string, cb: (tx: unknown) => unknown) =>
        cb({ auditLog: { create: auditCreate } }),
      ),
    } as unknown as PrismaService;
    svc = new AuthService(prisma, new JwtService());
  });

  const opts = (over: Partial<Parameters<AuthService['provisionAndLogin']>[0]> = {}) => ({
    tenantId: TENANT,
    email: 'user@acme.com',
    sub: 'okta-sub-123',
    source: 'okta',
    jitEnabled: true,
    defaultApiRole: 'viewer',
    ...over,
  });

  it('lookupIdpByDomain returns the first match or null', async () => {
    queryRaw.mockResolvedValueOnce([{ tenant_id: TENANT, idp_id: 'i1' }]);
    expect(await svc.lookupIdpByDomain('ACME.com')).toMatchObject({ idp_id: 'i1' });
    queryRaw.mockResolvedValueOnce([]);
    expect(await svc.lookupIdpByDomain('none.com')).toBeNull();
  });

  it('logs in an existing active identity without provisioning', async () => {
    queryRaw.mockResolvedValueOnce([{ user_id: 'u1', api_role: 'admin', active: true }]);
    const out = await svc.provisionAndLogin(opts());
    expect(out.claims).toMatchObject({ userId: 'u1', tenantId: TENANT, role: 'admin' });
    expect(out.accessToken).toBeTruthy();
    expect(queryRaw).toHaveBeenCalledTimes(1); // lookup only, no provision
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a deactivated identity (401)', async () => {
    queryRaw.mockResolvedValueOnce([{ user_id: 'u1', api_role: 'viewer', active: false }]);
    await expect(svc.provisionAndLogin(opts())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(queryRaw).toHaveBeenCalledTimes(1); // never tries to provision over an inactive row
  });

  it('JIT-provisions an absent identity and audits it', async () => {
    queryRaw
      .mockResolvedValueOnce([]) // lookup: absent
      .mockResolvedValueOnce([{ user_id: 'u2', api_role: 'viewer' }]); // provision
    const out = await svc.provisionAndLogin(opts());
    expect(out.claims).toMatchObject({ userId: 'u2', role: 'viewer' });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      actor: 'sso:okta',
      action: 'create',
      object: 'identity:u2',
    });
  });

  it('refuses an absent identity when JIT is disabled (401)', async () => {
    queryRaw.mockResolvedValueOnce([]); // lookup: absent
    await expect(svc.provisionAndLogin(opts({ jitEnabled: false }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('recovers from a provisioning race by re-reading the identity', async () => {
    queryRaw
      .mockResolvedValueOnce([]) // lookup: absent
      .mockResolvedValueOnce([]) // provision: lost the ON CONFLICT race
      .mockResolvedValueOnce([{ user_id: 'u3', api_role: 'analyst', active: true }]); // re-read
    const out = await svc.provisionAndLogin(opts());
    expect(out.claims).toMatchObject({ userId: 'u3', role: 'analyst' });
    expect(auditCreate).not.toHaveBeenCalled(); // the winner already audited it
  });
});
