import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Principal, runWithTenant } from '../tenant/tenant-context';
import { generateInviteToken, InvitesService } from './invites.service';

const principal: Principal = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  role: 'admin',
};

function harness(overrides?: {
  withTenantQuery?: unknown;
  withTenantExecute?: number;
  queryRaw?: unknown;
}) {
  const queryRaw = jest.fn().mockResolvedValue(overrides?.queryRaw ?? []);
  const executeRaw = jest.fn().mockResolvedValue(overrides?.withTenantExecute ?? 0);
  const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => unknown) => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(overrides?.withTenantQuery ?? []),
      $executeRaw: executeRaw,
    };
    return fn(tx);
  });
  const prisma = { $queryRaw: queryRaw, withTenant } as unknown as PrismaService;
  return { svc: new InvitesService(prisma), queryRaw, withTenant, executeRaw };
}

describe('generateInviteToken', () => {
  it('returns a 40-char hex raw token whose hash differs from the raw value', () => {
    const { raw, hash } = generateInviteToken();
    expect(raw).toMatch(/^[0-9a-f]{40}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(raw);
  });
});

describe('InvitesService.create', () => {
  it('throws when a pending invite already exists for the email', async () => {
    const { svc } = harness({ withTenantQuery: [{ count: 1 }] });
    await expect(
      runWithTenant(principal, () => svc.create({ email: 'a@b.com', apiRole: 'viewer' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('inserts and returns inviteId + link when no pending invite exists', async () => {
    const { svc, withTenant } = harness();
    // First withTenant call: duplicate check → count 0; second: insert
    withTenant
      .mockImplementationOnce(async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({ $queryRaw: jest.fn().mockResolvedValue([{ count: 0 }]), $executeRaw: jest.fn() }),
      )
      .mockImplementationOnce(async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({
          $queryRaw: jest.fn().mockResolvedValue([{ invite_id: 'inv-1' }]),
          $executeRaw: jest.fn(),
        }),
      );

    const out = await runWithTenant(principal, () =>
      svc.create({ email: 'New@Acme.com', apiRole: 'analyst' }),
    );
    expect(out.inviteId).toBe('inv-1');
    expect(out.link).toContain('/invite/accept?token=');
  });
});

describe('InvitesService.resolve', () => {
  it('throws NotFoundException for an unknown token', async () => {
    const { svc } = harness({ queryRaw: [] });
    await expect(svc.resolve('a'.repeat(40))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws BadRequestException for a short token', async () => {
    const { svc } = harness();
    await expect(svc.resolve('short')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('InvitesService.revoke', () => {
  it('throws NotFoundException when no pending invite matches', async () => {
    const { svc } = harness({ withTenantExecute: 0 });
    await expect(
      runWithTenant(principal, () => svc.revoke('33333333-3333-3333-3333-333333333333')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('InvitesService.accept', () => {
  it('returns email + tenantId from invite_accept', async () => {
    const { svc, queryRaw } = harness({
      queryRaw: [
        {
          user_id: 'u1',
          tenant_id: principal.tenantId,
          api_role: 'viewer',
          email: 'a@b.com',
        },
      ],
    });
    const out = await svc.accept('a'.repeat(40), 'Alex');
    expect(out).toEqual({ email: 'a@b.com', tenantId: principal.tenantId });
    expect(queryRaw).toHaveBeenCalled();
  });
});
