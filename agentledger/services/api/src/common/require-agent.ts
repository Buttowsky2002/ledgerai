import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';

/**
 * Assert an agent exists in the caller's tenant (RLS + explicit tenantId).
 * Cross-tenant / unknown IDs fail closed as 404 — never empty 200 aggregates.
 */
export async function requireAgentInTenant(
  prisma: PrismaService,
  agentId: string,
): Promise<void> {
  const tenantId = getTenantId();
  if (!tenantId) {
    throw new BadRequestException('no tenant in context');
  }
  const row = await prisma.withTenant(tenantId, (tx) =>
    tx.agent.findFirst({ where: { agentId, tenantId } }),
  );
  if (!row) {
    throw new NotFoundException('agent not found');
  }
}
