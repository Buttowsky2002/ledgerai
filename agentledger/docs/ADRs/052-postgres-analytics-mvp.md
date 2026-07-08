# ADR-052 — Postgres-only analytics backend + single-container Cloud Run MVP

Status: accepted
Date: 2026-07-06

## Context

The MVP deployment target is a single Google Cloud Run service backed only by
Cloud SQL Postgres — no ClickHouse, no Redpanda. The control-plane API, however,
was built against ClickHouse for all analytics: ~15 services issue
ClickHouse-dialect SQL through `ClickHouseService`, `/ready` hard-fails without
ClickHouse, and dashboards read materialized views (`spend_daily`, `v_roi`, …)
that only existed there. The frontend is a Next.js server app (BFF routes), so
"serve the React build as static files from the gateway" is not possible for
this codebase.

## Decision

1. **Repository seam, not a rewrite.** An abstract `AnalyticsStore`
   (`services/api/src/analytics-store/`) with the exact `ClickHouseService`
   surface (`query`, `queryScoped`, `command`, `insertRows`, `ping`).
   `BADGERIQ_ANALYTICS_BACKEND` (`clickhouse` default | `postgres`) selects the
   implementation via Nest DI. Business logic keeps its ClickHouse-dialect SQL;
   nothing ClickHouse-related is deleted.
2. **Dialect translation over query rewrites.** `PostgresAnalyticsStore`
   translates the dialect surface this repo actually uses ({name:Type} params,
   `toDate`/`toStartOf*`, `count()`/`countIf`/`sumIf`/`argMax`, nested `if()`,
   `FINAL`, `SETTINGS`, `ALTER TABLE … DELETE`, the `agentledger.` prefix) and
   fails loudly on anything else. Chosen over rewriting ~200 queries twice.
3. **Schema mirror in migration `023_analytics_mvp.sql`.**
   ReplacingMergeTree tables → Postgres tables with the ClickHouse ordering key
   as PRIMARY KEY (the store upserts; latest wins = `FINAL` semantics).
   SummingMergeTree MV targets → plain views over `llm_calls`;
   `coding_agent_daily` upserts with addition. `v_roi` and friends are ported
   views. Every table gets FORCE RLS (`tenant_id = app_current_tenant()::text`)
   and every view `security_invoker`, on top of the existing fail-closed
   `tenant_id = {tenant:String}` filter contract — the Postgres store binds the
   RLS GUC via `PrismaService.withTenant` on every scoped statement.
4. **One container, two processes** (`Dockerfile.mvp` + `deploy/mvp/start.js`):
   the Next.js dashboard on `$PORT` (UI at `/`, BFF at `/api/*`, plus new
   `/health`, `/ready`, `/version` routes) and the NestJS API on
   `127.0.0.1:8094`. If either process exits, the container exits. The API's
   `/ready` is backend-aware — ClickHouse is only pinged when it is the backend.
5. **Cloud Run config vars.** `PORT` was already honored; the DSN can now be
   assembled from `DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` (+`DB_PORT`,
   `DB_SSLMODE`, unix-socket `DB_HOST` for Cloud SQL), and `JWT_SECRET` is
   accepted alongside `BADGERIQ_JWT_SECRET`.

## Consequences

- Connect-a-source → dashboard works on Postgres alone; the ClickHouse path is
  unchanged and re-enabled by flipping `BADGERIQ_ANALYTICS_BACKEND`.
- The translator is deliberately narrow; new ClickHouse constructs must either
  be added to it (with spec coverage in `ch-sql-translator.spec.ts`) or avoided
  in shared queries. Unknown constructs throw rather than misbehave.
- Read-time aggregation replaces insert-time MVs; fine at MVP volume, and the
  seam is exactly where ClickHouse plugs back in when volume demands it.
- Go workers (ch-insert, reconciliation, attribution, risk) remain
  ClickHouse/Redpanda-only and are simply not deployed in MVP mode; import,
  connectors, and outcomes all flow through the API, which is backend-agnostic.
