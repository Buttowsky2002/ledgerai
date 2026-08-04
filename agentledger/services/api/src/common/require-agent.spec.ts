import { NotFoundException } from '@nestjs/common';
import { requireAgentInTenant } from './require-agent';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-context';

describe('requireAgentInTenant', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const agentId = '22222222-2222-4222-8222-222222222222';

  it('throws NotFoundException when the agent is missing in-tenant', async () => {
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ agent: { findFirst: jest.fn().mockResolvedValue(null) } }),
      ),
    } as unknown as PrismaService;

    await expect(
      runWithTenant({ tenantId, userId: null, role: 'admin' }, () =>
        requireAgentInTenant(prisma, agentId),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolves when the agent exists for the tenant', async () => {
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          agent: {
            findFirst: jest.fn().mockResolvedValue({ agentId, tenantId }),
          },
        }),
      ),
    } as unknown as PrismaService;

    await expect(
      runWithTenant({ tenantId, userId: null, role: 'admin' }, () =>
        requireAgentInTenant(prisma, agentId),
      ),
    ).resolves.toBeUndefined();
  });
});
