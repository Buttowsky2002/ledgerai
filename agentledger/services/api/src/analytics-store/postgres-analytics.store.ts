import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';
import { requireTenantFilter } from '../clickhouse/clickhouse.service';
import { AnalyticsStore, ChParam } from './analytics-store';
import { translateChSql } from './ch-sql-translator';

/**
 * Upsert behavior per analytics table, mirroring the ClickHouse engines:
 *   - ReplacingMergeTree → ON CONFLICT (ordering key) DO UPDATE (latest wins)
 *   - SummingMergeTree   → ON CONFLICT (ordering key) DO UPDATE with addition
 */
interface TableUpsert {
  key: string[];
  /** Columns summed on conflict (SummingMergeTree tables); others replace. */
  sum?: string[];
}

const TABLES: Record<string, TableUpsert> = {
  llm_calls: { key: ['tenant_id', 'ts', 'call_id'] },
  agent_runs: { key: ['tenant_id', 'started_at', 'run_id'] },
  outcomes: { key: ['tenant_id', 'ts', 'outcome_id'] },
  agent_tool_calls: { key: ['tenant_id', 'agent_id', 'tool_call_id'] },
  risk_events: { key: ['tenant_id', 'agent_id', 'event_id'] },
  agent_risk: { key: ['tenant_id', 'agent_id'] },
  agent_tool_allow: { key: ['tenant_id', 'agent_id', 'tool_name'] },
  roi_rates: { key: ['tenant_id', 'source_system', 'outcome_type'] },
  roi_overrides: { key: ['tenant_id', 'outcome_id'] },
  fixed_costs: { key: ['tenant_id', 'period_month', 'vendor', 'cost_type', 'line_item'] },
  provider_costs: {
    key: ['tenant_id', 'day', 'provider', 'model', 'source', 'line_item', 'virtual_key_id'],
  },
  cost_adjustments: { key: ['tenant_id', 'day', 'model'] },
  coding_agent_daily: {
    key: ['tenant_id', 'day', 'provider', 'user_id', 'team_id', 'agent_id'],
    sum: ['cost_usd', 'sessions', 'requests'],
  },
};

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function assertIdent(name: string, what: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`postgres-analytics: invalid ${what} identifier: ${name}`);
  }
}

/** Normalize a Postgres row to the shapes ClickHouse JSON output produced. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) {
      const iso = v.toISOString(); // 2026-07-06T00:00:00.000Z
      out[k] = iso.endsWith('T00:00:00.000Z')
        ? iso.slice(0, 10)
        : iso.slice(0, 23).replace('T', ' ');
    } else if (typeof v === 'bigint') {
      out[k] = Number(v);
    } else if (typeof v === 'boolean') {
      // ClickHouse comparisons yield UInt8 0/1.
      out[k] = v ? 1 : 0;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Postgres implementation of the analytics store (MVP backend).
 *
 * Consumers keep their ClickHouse-dialect SQL; this store translates it (see
 * ch-sql-translator.ts) and runs it via Prisma against the analytics tables
 * and views from deploy/postgres/023_analytics_mvp.sql (+ 028 RLS harden).
 *
 * Tenant isolation is double-layered: the same fail-closed
 * `tenant_id = {tenant:String}` filter contract as ClickHouse, PLUS Postgres
 * RLS — every statement that has a tenant (param, row, or async request
 * context via getTenantId()) runs inside `withTenant` so `app.tenant_id` is
 * bound (fail closed to zero rows otherwise).
 */
@Injectable()
export class PostgresAnalyticsStore extends AnalyticsStore {
  private readonly logger = new Logger(PostgresAnalyticsStore.name);
  /** table → column → udt type name (lazy information_schema cache). */
  private readonly columnTypes = new Map<string, Map<string, string>>();

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * Prefer an explicit tenant param/row value; otherwise the request principal
   * from AsyncLocalStorage. Empty string is treated as absent.
   */
  private resolveTenantId(explicit?: string | null): string | null {
    if (typeof explicit === 'string' && explicit !== '') return explicit;
    return getTenantId();
  }

  async query<T = Record<string, unknown>>(sql: string, params: Record<string, ChParam> = {}): Promise<T[]> {
    const { sql: pgSql, values } = translateChSql(sql, params);
    const tenant = this.resolveTenantId(typeof params.tenant === 'string' ? params.tenant : null);
    const rows = tenant
      ? await this.prisma.withTenant(tenant, (tx) => tx.$queryRawUnsafe<Record<string, unknown>[]>(pgSql, ...values))
      : await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(pgSql, ...values);
    return rows.map(normalizeRow) as T[];
  }

  async queryScoped<T = Record<string, unknown>>(sql: string, params: Record<string, ChParam> = {}): Promise<T[]> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new Error('no tenant in context');
    }
    requireTenantFilter(sql);
    const safe: Record<string, ChParam> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k !== 'tenant') safe[k] = v;
    }
    safe.tenant = tenantId;
    const { sql: pgSql, values } = translateChSql(sql, safe);
    try {
      const rows = await this.prisma.withTenant(tenantId, (tx) =>
        tx.$queryRawUnsafe<Record<string, unknown>[]>(pgSql, ...values),
      );
      return rows.map(normalizeRow) as T[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Postgres analytics query failed: ${msg}`);
      throw err;
    }
  }

  async command(sql: string, params: Record<string, ChParam> = {}): Promise<void> {
    const translated = translateChSql(sql, params);
    const values = translated.values;
    const pgSql = this.upsertifyInsert(translated.sql);
    const tenant = this.resolveTenantId(typeof params.tenant === 'string' ? params.tenant : null);
    if (tenant) {
      await this.prisma.withTenant(tenant, (tx) => tx.$executeRawUnsafe(pgSql, ...values));
    } else {
      await this.prisma.$executeRawUnsafe(pgSql, ...values);
    }
  }

  async insertRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    assertIdent(table, 'table');
    const types = await this.tableTypes(table);
    const upsert = TABLES[table];

    // Group rows by identical column signature (ClickHouse JSONEachRow lets
    // rows omit columns; Postgres needs a uniform column list per INSERT).
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const cols = Object.keys(row)
        .filter((c) => types.has(c))
        .sort();
      const sig = cols.join(',');
      const g = groups.get(sig);
      if (g) g.push(row);
      else groups.set(sig, [row]);
    }

    const tenant = this.resolveTenantId(
      typeof rows[0].tenant_id === 'string' ? (rows[0].tenant_id as string) : null,
    );
    if (!tenant) {
      throw new Error(
        'postgres-analytics: refuse insert without tenant_id (RLS require app.tenant_id binding)',
      );
    }
    await this.prisma.withTenant(tenant, async (tx) => {
      for (const [sig, groupRows] of groups) {
        const cols = sig === '' ? [] : sig.split(',');
        if (cols.length === 0) continue;
        const { sql, values } = this.buildInsert(table, cols, groupRows, types, upsert);
        await tx.$executeRawUnsafe(sql, ...values);
      }
    });
  }

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  private buildInsert(
    table: string,
    cols: string[],
    rows: Record<string, unknown>[],
    types: Map<string, string>,
    upsert: TableUpsert | undefined,
  ): { sql: string; values: unknown[] } {
    const values: unknown[] = [];
    const tuples = rows.map((row) => {
      const placeholders = cols.map((c) => {
        values.push(this.coerce(row[c]));
        return `$${values.length}::${types.get(c)}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    let sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}`;
    sql += this.conflictClause(table, cols, upsert);
    return { sql, values };
  }

  private conflictClause(table: string, cols: string[], upsert: TableUpsert | undefined): string {
    if (!upsert) return '';
    if (!upsert.key.every((k) => cols.includes(k))) {
      // Without the full conflict key we cannot upsert deterministically.
      return '';
    }
    const nonKey = cols.filter((c) => !upsert.key.includes(c));
    if (nonKey.length === 0) return ` ON CONFLICT (${upsert.key.join(', ')}) DO NOTHING`;
    const sets = nonKey.map((c) =>
      upsert.sum?.includes(c) ? `${c} = ${table}.${c} + EXCLUDED.${c}` : `${c} = EXCLUDED.${c}`,
    );
    return ` ON CONFLICT (${upsert.key.join(', ')}) DO UPDATE SET ${sets.join(', ')}`;
  }

  /**
   * Rewrite a translated plain `INSERT INTO <known table> (cols) VALUES ...`
   * (the command() path used by roi-templates and the tool allowlist) into an
   * upsert, matching ReplacingMergeTree replace-on-key semantics.
   */
  private upsertifyInsert(sql: string): string {
    const m = /^\s*INSERT\s+INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/i.exec(sql);
    if (!m) return sql;
    const table = m[1].toLowerCase();
    const upsert = TABLES[table];
    if (!upsert || /ON\s+CONFLICT/i.test(sql)) return sql;
    const cols = m[2].split(',').map((c) => c.trim().toLowerCase());
    return sql + this.conflictClause(table, cols, upsert);
  }

  private coerce(v: unknown): unknown {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'object' && v !== null && !(v instanceof Date)) return JSON.stringify(v);
    return v;
  }

  private async tableTypes(table: string): Promise<Map<string, string>> {
    const cached = this.columnTypes.get(table);
    if (cached) return cached;
    const rows = await this.prisma.$queryRaw<{ column_name: string; udt_name: string }[]>`
      SELECT column_name, udt_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ${table}`;
    if (rows.length === 0) {
      throw new Error(
        `postgres-analytics: unknown analytics table "${table}" — is migration 023_analytics_mvp.sql applied?`,
      );
    }
    const map = new Map(rows.map((r) => [r.column_name, r.udt_name]));
    this.columnTypes.set(table, map);
    return map;
  }
}
