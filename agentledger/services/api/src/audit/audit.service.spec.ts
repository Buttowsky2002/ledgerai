jest.mock('../tenant/tenant-context', () => ({
  getTenantId: () => 'tenant-1',
}));

import { AuditService } from './audit.service';

describe('AuditService', () => {
  it('maps audit rows and resolves actor identity labels', async () => {
    const auditRows = [
      {
        id: BigInt(7),
        at: new Date('2026-07-28T12:00:00.000Z'),
        actor: '11111111-1111-4111-8111-111111111111',
        action: 'login',
        object: 'session',
        detail: { ip: '127.0.0.1' },
      },
      {
        id: BigInt(8),
        at: new Date('2026-07-28T12:01:00.000Z'),
        actor: 'system',
        action: 'create',
        object: 'team:abc',
        detail: { before: null, after: { name: 'Eng' } },
      },
    ];
    const identities = [
      {
        userId: '11111111-1111-4111-8111-111111111111',
        email: 'brandon@studiodesigner.com',
        displayName: 'Brandon',
      },
    ];

    const findMany = jest.fn(async () => auditRows);
    const count = jest.fn(async () => 2);
    const withTenant = jest.fn(async (_tenant: string, fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        auditLog: { findMany, count },
        identity: {
          findMany: jest.fn(async () => identities),
        },
      };
      return fn(tx);
    });

    const svc = new AuditService({ withTenant } as never);
    const result = await svc.list({
      limit: 50,
      offset: 0,
      from: '2026-07-01',
      to: '2026-07-31',
      action: 'login',
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: 'login',
          at: expect.objectContaining({
            gte: new Date('2026-07-01T00:00:00.000Z'),
            lte: new Date('2026-07-31T23:59:59.999Z'),
          }),
        }),
      }),
    );
    expect(result.total).toBe(2);
    expect(result.rows).toEqual([
      {
        id: '7',
        at: '2026-07-28T12:00:00.000Z',
        actor: '11111111-1111-4111-8111-111111111111',
        actorEmail: 'brandon@studiodesigner.com',
        actorDisplayName: 'Brandon',
        action: 'login',
        object: 'session',
        detail: { ip: '127.0.0.1' },
      },
      {
        id: '8',
        at: '2026-07-28T12:01:00.000Z',
        actor: 'system',
        actorEmail: null,
        actorDisplayName: null,
        action: 'create',
        object: 'team:abc',
        detail: { before: null, after: { name: 'Eng' } },
      },
    ]);
  });
});
