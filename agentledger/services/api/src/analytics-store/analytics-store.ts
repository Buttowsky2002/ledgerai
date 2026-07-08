export type ChParam = string | number;

/**
 * Analytics-store repository seam (MVP consolidation).
 *
 * Business logic writes ClickHouse-dialect SQL against one of two backends,
 * selected by `BADGERIQ_ANALYTICS_BACKEND`:
 *
 *   - `clickhouse` (default) — ClickHouseService, the original HTTP client.
 *   - `postgres`             — PostgresAnalyticsStore, which translates the
 *     ClickHouse dialect to Postgres and runs against the tables/views created
 *     by deploy/postgres/023_analytics_mvp.sql. This is the Cloud Run MVP mode
 *     (single database, no ClickHouse / Redpanda).
 *
 * The contract mirrors the original ClickHouseService surface so no consumer
 * rewrites its queries:
 *   - `query`       unscoped query (health ping, explicitly-parameterized reads)
 *   - `queryScoped` tenant-scoped query; binds `tenant` from the request
 *                   principal and fails closed without an explicit
 *                   `tenant_id = {tenant:String}` filter
 *   - `command`     statement without a result set (INSERT / ALTER ... DELETE)
 *   - `insertRows`  bulk JSONEachRow-style insert
 *   - `ping`        connectivity check for /ready
 */
export abstract class AnalyticsStore {
  abstract query<T = Record<string, unknown>>(sql: string, params?: Record<string, ChParam>): Promise<T[]>;
  abstract queryScoped<T = Record<string, unknown>>(sql: string, params?: Record<string, ChParam>): Promise<T[]>;
  abstract command(sql: string, params?: Record<string, ChParam>): Promise<void>;
  abstract insertRows(table: string, rows: Record<string, unknown>[]): Promise<void>;
  abstract ping(): Promise<void>;
}

export type AnalyticsBackend = 'clickhouse' | 'postgres';

/** Which analytics backend this deployment uses (default: clickhouse). */
export function analyticsBackend(): AnalyticsBackend {
  const raw = (process.env.BADGERIQ_ANALYTICS_BACKEND ?? '').trim().toLowerCase();
  if (raw === 'postgres' || raw === 'postgresql' || raw === 'pg') return 'postgres';
  return 'clickhouse';
}
