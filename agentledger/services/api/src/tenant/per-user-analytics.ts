import { PrismaService } from '../prisma/prisma.service';

export type PerUserAnalyticsMode = 'individual' | 'team';

/**
 * Tenant privacy gate for per-user utilization analytics.
 * Defaults to team-level aggregates when unset (no PG migration required).
 */
export async function getPerUserAnalyticsMode(
  prisma: PrismaService,
  tenantId: string,
): Promise<PerUserAnalyticsMode> {
  const row = await prisma.withTenant(tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { tenantId },
      select: { complianceFlags: true },
    }),
  );
  const flags = (row?.complianceFlags ?? {}) as Record<string, unknown>;
  return flags.perUserAnalytics === 'individual' ? 'individual' : 'team';
}
