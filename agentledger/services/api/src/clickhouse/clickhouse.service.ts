import { Injectable, Logger } from '@nestjs/common';
import { getTenantId } from '../tenant/tenant-context';

export type ChParam = string | number;

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
  private readonly url = (process.env.AGENTLEDGER_CLICKHOUSE_URL ?? 'http://localhost:8123').replace(/\/$/, '');
  private readonly db = process.env.AGENTLEDGER_CLICKHOUSE_DB ?? 'agentledger';
  private readonly user = process.env.AGENTLEDGER_CLICKHOUSE_USER ?? 'default';
  private readonly password = process.env.AGENTLEDGER_CLICKHOUSE_PASSWORD ?? '';

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
   * Tenant-scoped query: binds `param_tenant` from the request principal. The SQL
   * MUST filter `WHERE tenant_id = {tenant:String}`. Fails closed if no principal.
   */
  async queryScoped<T = Record<string, unknown>>(sql: string, params: Record<string, ChParam> = {}): Promise<T[]> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new Error('no tenant in context');
    }
    return this.query<T>(sql, { ...params, tenant: tenantId });
  }

  async ping(): Promise<void> {
    await this.query('SELECT 1');
  }
}
