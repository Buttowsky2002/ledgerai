import { Prisma } from '@prisma/client';
import { getPrincipal } from '../tenant/tenant-context';

export type AuditAction = 'create' | 'update' | 'delete';

export interface AuditEvent {
  action: AuditAction;
  /** Resource label + id, e.g. "team:<uuid>". */
  object: string;
  before: unknown;
  after: unknown;
}

/**
 * Append an administrative-mutation row to audit_log (security rule 10: who/what/
 * before-after/when). Called INSIDE the same tenant-scoped transaction as the
 * mutation, so it is atomic with the change and its tenant_id matches
 * app.tenant_id (RLS WITH CHECK passes).
 *
 * before/after are run through JSON to flatten Prisma Decimal/Date into plain
 * JSON for the JSONB column (and to avoid storing class instances).
 */
export async function recordAudit(tx: Prisma.TransactionClient, e: AuditEvent): Promise<void> {
  const principal = getPrincipal();
  await tx.auditLog.create({
    data: {
      tenantId: principal?.tenantId ?? '',
      actor: principal?.userId ?? 'system',
      action: e.action,
      object: e.object,
      detail: JSON.parse(JSON.stringify({ before: e.before ?? null, after: e.after ?? null })),
    },
  });
}
