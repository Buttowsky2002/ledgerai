import { Global, Logger, Module } from '@nestjs/common';
import { AnalyticsStore, analyticsBackend } from '../analytics-store/analytics-store';
import { PostgresAnalyticsStore } from '../analytics-store/postgres-analytics.store';
import { ClickHouseService } from './clickhouse.service';

/**
 * Global analytics-store module. `BADGERIQ_ANALYTICS_BACKEND` selects the
 * implementation behind the AnalyticsStore token:
 *
 *   clickhouse (default) — the original ClickHouse HTTP client
 *   postgres             — Postgres-only MVP backend (Cloud Run: one database,
 *                          no ClickHouse / Redpanda); requires migration
 *                          deploy/postgres/023_analytics_mvp.sql
 *
 * ClickHouseService stays provided/exported so ClickHouse-specific tooling can
 * still inject it explicitly; business logic must inject AnalyticsStore.
 */
@Global()
@Module({
  providers: [
    ClickHouseService,
    PostgresAnalyticsStore,
    {
      provide: AnalyticsStore,
      inject: [ClickHouseService, PostgresAnalyticsStore],
      useFactory: (ch: ClickHouseService, pg: PostgresAnalyticsStore): AnalyticsStore => {
        const backend = analyticsBackend();
        new Logger('AnalyticsStore').log(`analytics backend: ${backend}`);
        return backend === 'postgres' ? pg : ch;
      },
    },
  ],
  exports: [ClickHouseService, AnalyticsStore],
})
export class ClickHouseModule {}
