/* eslint-disable @typescript-eslint/no-explicit-any */
// The Prisma model delegate is selected dynamically per resource, so this base is
// intentionally untyped at the delegate boundary; concrete controllers supply
// validated DTOs, and RLS + the @Roles guards enforce tenancy/authorization.
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';
import { Page } from './pagination';
import { recordAudit } from './audit';

export interface CrudConfig {
  /** Prisma delegate name on the client, e.g. 'team'. */
  model: string;
  /** Primary-key field, e.g. 'teamId'. */
  idField: string;
  /** Audit object label, e.g. 'team'. */
  object: string;
  /**
   * Inject the caller's tenant_id on create (default true). False for global
   * tables with no tenant_id (e.g. price_book) — RLS still doesn't apply there,
   * but the audit row written in the same transaction does pick up app.tenant_id.
   */
  injectTenant?: boolean;
}

/**
 * Generic tenant-scoped CRUD. Every operation runs inside
 * PrismaService.withTenant(...) so Postgres RLS (ADR-010) confines it to the
 * caller's tenant. Lookups also include an explicit `tenantId` predicate
 * (defense-in-depth) whenever the table is tenant-scoped. Mutations inject the
 * tenant id on create and append an audit_log row in the same transaction
 * (ADR-012). A row that belongs to another tenant is invisible under RLS and
 * fails the compound where, so get/update/delete raise 404 (never cross-tenant
 * leakage).
 */
export class CrudService {
  constructor(
    protected readonly prisma: PrismaService,
    protected readonly cfg: CrudConfig,
  ) {}

  private delegate(tx: Prisma.TransactionClient): any {
    return (tx as any)[this.cfg.model];
  }

  /** PK (+ tenantId when the table is tenant-scoped). Uses findFirst-compatible where. */
  private scopedWhere(id: string): Record<string, string> {
    const where: Record<string, string> = { [this.cfg.idField]: id };
    if (this.cfg.injectTenant !== false) {
      const tid = getTenantId();
      if (tid) where.tenantId = tid;
    }
    return where;
  }

  list(page: Page): Promise<any[]> {
    return this.prisma.withTenant(getTenantId(), (tx) =>
      this.delegate(tx).findMany({
        take: page.limit,
        skip: page.offset,
        orderBy: { [this.cfg.idField]: 'asc' },
      }),
    );
  }

  async get(id: string): Promise<any> {
    const row = await this.prisma.withTenant(getTenantId(), (tx) =>
      this.delegate(tx).findFirst({ where: this.scopedWhere(id) }),
    );
    if (!row) {
      throw new NotFoundException(`${this.cfg.object} not found`);
    }
    return row;
  }

  create(data: Record<string, unknown>): Promise<any> {
    return this.prisma.withTenant(getTenantId(), async (tx) => {
      const payload =
        this.cfg.injectTenant === false ? { ...data } : { ...data, tenantId: getTenantId() };
      const created = await this.delegate(tx).create({ data: payload });
      await recordAudit(tx, {
        action: 'create',
        object: `${this.cfg.object}:${created[this.cfg.idField]}`,
        before: null,
        after: created,
      });
      return created;
    });
  }

  update(id: string, data: Record<string, unknown>): Promise<any> {
    return this.prisma.withTenant(getTenantId(), async (tx) => {
      const before = await this.delegate(tx).findFirst({ where: this.scopedWhere(id) });
      if (!before) {
        throw new NotFoundException(`${this.cfg.object} not found`);
      }
      const after = await this.delegate(tx).update({
        where: { [this.cfg.idField]: id },
        data,
      });
      await recordAudit(tx, { action: 'update', object: `${this.cfg.object}:${id}`, before, after });
      return after;
    });
  }

  remove(id: string): Promise<{ deleted: true }> {
    return this.prisma.withTenant(getTenantId(), async (tx) => {
      const before = await this.delegate(tx).findFirst({ where: this.scopedWhere(id) });
      if (!before) {
        throw new NotFoundException(`${this.cfg.object} not found`);
      }
      await this.delegate(tx).delete({ where: { [this.cfg.idField]: id } });
      await recordAudit(tx, { action: 'delete', object: `${this.cfg.object}:${id}`, before, after: null });
      return { deleted: true };
    });
  }
}
