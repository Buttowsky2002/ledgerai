import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';

export type AuditListItem = {
  id: string;
  at: string;
  actor: string;
  actorEmail: string | null;
  actorDisplayName: string | null;
  action: string;
  object: string;
  detail: Record<string, unknown>;
};

/**
 * Tenant-scoped reads of audit_log for the Settings → Auditing UI.
 * Mutations continue to go through recordAudit() / recordAuthAudit() writers.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(opts: {
    limit: number;
    offset: number;
    action?: string;
  }): Promise<AuditListItem[]> {
    const tenantId = getTenantId();
    const where: Prisma.AuditLogWhereInput = {};
    if (opts.action) {
      where.action = opts.action;
    }

    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.auditLog.findMany({
        where,
        orderBy: { at: 'desc' },
        take: opts.limit,
        skip: opts.offset,
      }),
    );

    const actorIds = [
      ...new Set(
        rows
          .map((r) => r.actor)
          .filter((a) => /^[0-9a-f-]{36}$/i.test(a)),
      ),
    ];

    const identities =
      actorIds.length === 0
        ? []
        : await this.prisma.withTenant(tenantId, (tx) =>
            tx.identity.findMany({
              where: { userId: { in: actorIds } },
              select: { userId: true, email: true, displayName: true },
            }),
          );

    const byId = new Map(identities.map((i) => [i.userId, i]));

    return rows.map((r) => {
      const ident = byId.get(r.actor);
      const detail =
        r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail)
          ? (r.detail as Record<string, unknown>)
          : {};
      return {
        id: String(r.id),
        at: r.at.toISOString(),
        actor: r.actor,
        actorEmail: ident?.email ?? null,
        actorDisplayName: ident?.displayName ?? null,
        action: r.action,
        object: r.object,
        detail,
      };
    });
  }
}
