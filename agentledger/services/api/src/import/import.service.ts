import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { AnalyticsStore } from '../analytics-store/analytics-store';

import { PrismaService } from '../prisma/prisma.service';

import { getPrincipal, getTenantId } from '../tenant/tenant-context';

import { ImportEventsDto } from './import.dto';

import { ImportRowError, MappedEvent, mapRow } from './import.mapper';



export interface ImportRowErrorDetail {

  line: number;

  message: string;

}



export interface ImportSummary {

  /** Rows in the request. */

  received: number;

  /** Rows whose events were inserted (this request won their idempotency key, or

   *  the row had no key). */

  imported: number;

  /** Rows skipped because their idempotency key was already imported — by an

   *  earlier request OR a concurrent one. `received === imported + skipped`. */

  skipped: number;

  /** Rows carrying no idempotency_key. These are NOT de-duplicated and are

   *  re-imported on every retry — surfaced so callers know a keyless retry is unsafe. */

  keyless: number;

  /** Total canonical events written across all tables. */

  events: number;

  /** Per-table event counts (llm_calls / agent_tool_calls / outcomes / risk_events). */

  byTable: Record<string, number>;

  /** True when this was a dry run (nothing was written). */

  dryRun: boolean;

}



type Mapped = { key?: string; events: MappedEvent[] };



/**

 * Bulk event import (POST /v1/import/events).

 *

 * Maps flat import rows to canonical ClickHouse rows (import.mapper), de-duplicates

 * against prior imports via the tenant-scoped `import_idempotency` ledger, and

 * bulk-inserts the fresh events. tenant_id is always stamped from the request

 * principal — never from request input (security rule 3). The whole batch is

 * all-or-nothing on validation: a single malformed row rejects the request with

 * the offending line numbers, so a partial apply never surprises the caller.

 *

 * Delivery is **at-least-once** for keyed rows: the idempotency ledger guarantees

 * a re-import never double-counts (including under concurrency — see below), but

 * because ClickHouse is not enrolled in the Postgres transaction there is a narrow

 * window (a transaction-commit failure *after* a successful ClickHouse write) where

 * a retry of that batch could double-count. Rows WITHOUT an idempotency_key are not

 * de-duplicated at all and are re-imported on every retry.

 */

@Injectable()

export class ImportService {

  private readonly logger = new Logger(ImportService.name);



  constructor(

    private readonly ch: AnalyticsStore,

    private readonly prisma: PrismaService,

  ) {}



  async importEvents(dto: ImportEventsDto): Promise<ImportSummary> {

    const tenantId = getTenantId();

    if (!tenantId) {

      throw new BadRequestException('no tenant in context');

    }

    const rows = dto.events;

    const dryRun = dto.dryRun === true;



    // 1. Map every row up front. Any invalid row fails the entire batch (with the

    //    line number) — nothing is written when validation fails.

    const mapped: Mapped[] = [];

    const errors: ImportRowErrorDetail[] = [];

    rows.forEach((raw, i) => {

      try {

        const m = mapRow(raw);

        mapped.push({ key: m.idempotencyKey, events: m.events });

      } catch (e) {

        if (e instanceof ImportRowError) {

          errors.push({ line: i + 1, message: e.message });

        } else {

          throw e;

        }

      }

    });

    if (errors.length > 0) {

      throw new BadRequestException({ message: 'import validation failed', errors });

    }



    // 2. Collapse keys repeated within this batch (first occurrence wins) so a key

    //    sent twice in one request is imported once.

    const seen = new Set<string>();

    const deduped = mapped.filter((m) => {

      if (!m.key) return true;

      if (seen.has(m.key)) return false;

      seen.add(m.key);

      return true;

    });

    const keyless = deduped.filter((m) => !m.key).length;

    const keys = deduped.map((m) => m.key).filter((k): k is string => !!k);



    // 3–4. Reserve idempotency keys and stage rows inside a short transaction — do

    // not hold a pool connection open during analytics inserts (insertRows opens its

    // own withTenant on the Postgres backend).

    const { summary, byTable } = await this.prisma.withTenant(tenantId, async (tx) => {

      let wonKeys: Set<string>;

      if (dryRun) {

        const existing =

          keys.length > 0

            ? await tx.importIdempotency.findMany({

                where: { idempotencyKey: { in: keys } },

                select: { idempotencyKey: true },

              })

            : [];

        const existingSet = new Set(existing.map((e) => e.idempotencyKey));

        wonKeys = new Set(keys.filter((k) => !existingSet.has(k)));

      } else if (keys.length > 0) {

        const values = Prisma.join(keys.map((k) => Prisma.sql`(${tenantId}::uuid, ${k})`));

        const won = await tx.$queryRaw<{ idempotency_key: string }[]>(

          Prisma.sql`INSERT INTO import_idempotency (tenant_id, idempotency_key)

                     VALUES ${values}

                     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING

                     RETURNING idempotency_key`,

        );

        wonKeys = new Set(won.map((w) => w.idempotency_key));

      } else {

        wonKeys = new Set();

      }

      const fresh = deduped.filter((m) => !m.key || wonKeys.has(m.key));



      const byTable = new Map<string, Record<string, unknown>[]>();

      for (const m of fresh) {

        for (const ev of m.events) {

          const list = byTable.get(ev.table) ?? [];

          list.push({ ...ev.row, tenant_id: tenantId });

          byTable.set(ev.table, list);

        }

      }

      const tableCounts: Record<string, number> = {};

      let eventCount = 0;

      for (const [table, list] of byTable) {

        tableCounts[table] = list.length;

        eventCount += list.length;

      }



      const summary: ImportSummary = {

        received: rows.length,

        imported: fresh.length,

        skipped: rows.length - fresh.length,

        keyless,

        events: eventCount,

        byTable: tableCounts,

        dryRun,

      };



      return { summary, byTable };

    });



    if (dryRun) {

      return summary;

    }



    // 5. Bulk-insert each table's rows after the reservation transaction commits.

    for (const [table, list] of byTable) {

      await this.ch.insertRows(table, list);

    }



    // 6. Audit the data ingestion (rule 10).

    await this.prisma.withTenant(tenantId, (tx) =>

      tx.auditLog.create({

        data: {

          tenantId,

          actor: getPrincipal()?.userId ?? 'system',

          action: 'import',

          object: 'import:events',

          detail: {

            received: summary.received,

            imported: summary.imported,

            skipped: summary.skipped,

            keyless,

            events: summary.events,

            byTable: summary.byTable,

          },

        },

      }),

    );



    this.logger.log(

      { event: 'import_events', tenantId, ...summary.byTable, imported: summary.imported, skipped: summary.skipped, keyless },

      'import',

    );

    return summary;

  }



  /** Release idempotency keys for a connector so a re-sync can replace stale rows. */

  async releaseConnectorImportKeys(connectorId: string): Promise<void> {

    const tenantId = getTenantId();

    if (!tenantId) throw new BadRequestException('no tenant in context');

    const prefix = `conn_${connectorId}_`;

    await this.prisma.withTenant(tenantId, (tx) =>

      tx.$executeRaw`

        DELETE FROM import_idempotency

        WHERE tenant_id = ${tenantId}::uuid

          AND idempotency_key LIKE ${`${prefix}%`}`,

    );

  }

}


