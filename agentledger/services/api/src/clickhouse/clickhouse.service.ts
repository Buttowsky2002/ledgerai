import { Injectable, Logger } from '@nestjs/common';
import { getTenantId } from '../tenant/tenant-context';
import { env } from '../env';

export type ChParam = string | number;

// A query is tenant-scoped only if it contains an explicit
// `tenant_id = {tenant:String}` filter binding the principal's tenant. Accepts
// the equivalent forms `tenant_id = {tenant:String}`, `tenant_id={tenant:String}`,
// and `alias.tenant_id = {tenant:String}` (the `\b` matches right after a `.`).
const TENANT_FILTER = /\btenant_id\s*=\s*\{\s*tenant\s*:\s*String\s*\}/i;

/**
 * Fail-closed guard for tenant-scoped queries: throws unless the SQL contains an
 * explicit tenant filter that binds the principal's tenant. Without it a query
 * would silently return every tenant's rows, so this rejects the query before it
 * ever reaches ClickHouse (which has no row-level security).
 */
export function requireTenantFilter(sql: string): void {
  if (!TENANT_FILTER.test(sql)) {
    throw new Error(
      'queryScoped requires an explicit tenant filter (tenant_id = {tenant:String}); ' +
        'refusing to run an unscoped tenant query',
    );
  }
}

/**
 * Minimal ClickHouse client over the HTTP interface (Node global fetch — no new
 * dependency, mirroring the workers' stdlib JSONEachRow approach). Queries are
 * **parameterized** via ClickHouse server-side substitution (`param_<name>` →
 * `{name:Type}` in SQL); values are never interpolated into SQL (security rule 4).
 *
 * ClickHouse has no row-level security, so tenant isolation lives entirely in the
 * `tenant_id = {tenant:String}` filter that `queryScoped` injects from the request
 * principal — never from request input (security rule 3).
 */
@Injectable()
export class ClickHouseService {
  private readonly logger = new Logger(ClickHouseService.name);
  private readonly url = (env('BADGERIQ_CLICKHOUSE_URL') ?? 'http://localhost:8123').replace(/\/$/, '');
  private readonly db = env('BADGERIQ_CLICKHOUSE_DB') ?? 'agentledger';
  private readonly user = env('BADGERIQ_CLICKHOUSE_USER') ?? 'default';
  private readonly password = env('BADGERIQ_CLICKHOUSE_PASSWORD') ?? '';

  /** Run a query with bound parameters. Returns the JSON `data` rows. */
  async query<T = Record<string, unknown>>(sql: string, params: Record<string, ChParam> = {}): Promise<T[]> {
    const qs = new URLSearchParams({ database: this.db, default_format: 'JSON' });
    for (const [k, v] of Object.entries(params)) {
      qs.set(`param_${k}`, String(v));
    }
    const res = await fetch(`${this.url}/?${qs.toString()}`, {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': this.user,
        ...(this.password ? { 'X-ClickHouse-Key': this.password } : {}),
        'Content-Type': 'text/plain',
      },
      body: sql,
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`clickhouse query failed (${res.status})`);
      throw new Error(`clickhouse ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: T[] };
    return json.data ?? [];
  }

  /**
   * Execute a statement that returns no result set (DDL / INSERT / ALTER … DELETE).
   * Unlike `query`, it does not request or parse a JSON body (ALTER returns empty).
   */
  async command(sql: string, params: Record<string, ChParam> = {}): Promise<void> {
    const qs = new URLSearchParams({ database: this.db });
    for (const [k, v] of Object.entries(params)) {
      qs.set(`param_${k}`, String(v));
    }
    const res = await fetch(`${this.url}/?${qs.toString()}`, {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': this.user,
        ...(this.password ? { 'X-ClickHouse-Key': this.password } : {}),
        'Content-Type': 'text/plain',
      },
      body: sql,
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`clickhouse command failed (${res.status})`);
      throw new Error(`clickhouse ${res.status}: ${text.slice(0, 300)}`);
    }
  }

  /**
   * Tenant-scoped query: binds `param_tenant` from the request principal. Fails
   * closed two ways: it throws if there is no principal, and it throws unless the
   * SQL contains an explicit `tenant_id = {tenant:String}` filter (so a query that
   * forgot to scope by tenant is rejected rather than leaking every tenant's
   * rows). A caller-supplied `tenant` param is dropped — request input can never
   * override the principal's tenant (security rule 3).
   *
   * Dashboard queries should go through the named methods on AnalyticsService
   * (spend/allocation/modelMix/…), which compose these scoped queries — callers
   * should not hand-write ad-hoc scoped SQL.
   */
  async queryScoped<T = Record<string, unknown>>(sql: string, params: Record<string, ChParam> = {}): Promise<T[]> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new Error('no tenant in context');
    }
    requireTenantFilter(sql);
    // Bound tenant always wins: strip any caller-supplied `tenant` then set it.
    const safe: Record<string, ChParam> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k !== 'tenant') {
        safe[k] = v;
      }
    }
    safe.tenant = tenantId;
    return this.query<T>(sql, safe);
  }

  /**
   * Bulk-insert rows via JSONEachRow. `table` MUST be a fixed internal constant
   * (never user input) — it is interpolated into the INSERT statement; the row
   * values travel in the JSON body, which ClickHouse parses safely (no SQL
   * injection). Omitted columns fall back to their defaults; `ts` accepts ISO
   * timestamps (best_effort). Callers stamp tenant_id from the principal.
   */
  async insertRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    const qs = new URLSearchParams({
      database: this.db,
      date_time_input_format: 'best_effort',
      input_format_skip_unknown_fields: '1',
    });
    const body =
      `INSERT INTO ${this.db}.${table} FORMAT JSONEachRow\n` +
      rows.map((r) => JSON.stringify(r)).join('\n');
    const res = await fetch(`${this.url}/?${qs.toString()}`, {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': this.user,
        ...(this.password ? { 'X-ClickHouse-Key': this.password } : {}),
        'Content-Type': 'text/plain',
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`clickhouse insert failed (${res.status})`);
      throw new Error(`clickhouse ${res.status}: ${text.slice(0, 300)}`);
    }
  }

  async ping(): Promise<void> {
    await this.query('SELECT 1');
  }
}
