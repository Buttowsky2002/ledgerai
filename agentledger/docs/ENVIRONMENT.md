# Environment variables

Every variable uses the **`BADGERIQ_*`** prefix. The deprecated **`BADGERIQ_*`**
and legacy **`AGENTLEDGER_*`** names are still read as aliases (a service prefers
`BADGERIQ_*` and falls back to the older prefixes), so existing deployments keep
working — migrate by renaming the prefix. See the repo README "Renaming to BadgerIQ".

**Secret rule:** config holds env-var *names*, never secret values. Provider keys,
the Redis password, and OIDC client secrets are referenced by the env-var name they
live in. Never commit a secret. For deployment modes see [`DEPLOYMENT.md`](DEPLOYMENT.md);
for an example file see [`.env.example`](../.env.example).

> 🔒 = secret (inject via a secret manager).

## Cross-cutting (most services)

| Variable | Default | Purpose |
|----------|---------|---------|
| `BADGERIQ_CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint. |
| `BADGERIQ_CLICKHOUSE_DB` | `agentledger` | ClickHouse database. |
| `BADGERIQ_CLICKHOUSE_USER` | `default` | ClickHouse user. |
| 🔒 `BADGERIQ_CLICKHOUSE_PASSWORD` | _(empty)_ | ClickHouse password. |
| 🔒 `BADGERIQ_PG_DSN` | _(per service)_ | Postgres DSN; use the non-superuser `agentledger_api` role (RLS). |
| `BADGERIQ_<svc>_WORKER_ADDR` / `_ADDR` | per service | Health/metrics listen address. |

## Gateway (`services/gateway`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `BADGERIQ_CONFIG` | `config.json` | Path to the gateway config file (virtual keys, providers, DLP). |
| 🔒 `BADGERIQ_PG_DSN` | _(unset)_ | Optional: load virtual keys/DLP/tool-allowlist from Postgres (hot reload). Unset = static file config. |
| 🔒 `BADGERIQ_OPS_TOKEN` | _(unset)_ | Bearer required for `/v1/usage` and `/metrics`. Unset in prod → those return 404. |
| `BADGERIQ_ENV` | _(unset)_ | `production` locks ops endpoints when no token is set. |
| `BADGERIQ_ALLOW_UNAUTH_OPS` | _(unset)_ | Dev-only: allow unauthenticated ops access. Never in prod. |
| `BADGERIQ_METRICS_PUBLIC` | _(unset)_ | `true` exposes `/metrics` unauthenticated (trusted private scrape net only). |
| `BADGERIQ_DEFAULT_RESERVE_USD` | `0.01` | Budget hold when a request has no `max_tokens`. |
| `BADGERIQ_BUDGET_FAIL_MODE` | `open` | On a Redis error: `open` (serve) or `closed` (reject). |
| `BADGERIQ_EVENT_SPOOL_DIR` | _(unset)_ | Persist failed event flushes as ndjson (content-free) for replay. |
| `BADGERIQ_EVENT_FAIL_MODE` | `observe_only` | `observe_only` (drop on full buffer, counted) or `strict` (backpressure). |
| 🔒 provider keys | — | Referenced by **name** in the config's `api_key_env` (e.g. `OPENAI_API_KEY`). |
| 🔒 Redis password | — | Referenced by **name** in the config's `redis.password_env`. |

## Collector (`services/ingest/collector` → `services/collector`)

`BADGERIQ_COLLECTOR_ADDR`, `BADGERIQ_KAFKA_BROKERS`, `BADGERIQ_KAFKA_TOPIC`,
`BADGERIQ_EVENT_SCHEMA`, `BADGERIQ_MAX_BODY_BYTES`, `BADGERIQ_MAX_BATCH`,
`BADGERIQ_MAX_INFLIGHT`, `BADGERIQ_OTEL_TENANT_ATTR`, `BADGERIQ_OTEL_DEFAULT_TENANT`.
Full table: `services/collector/README.md`.

## Workers (`services/workers`, one `cmd/` per worker)

Common: the cross-cutting ClickHouse vars + `BADGERIQ_WORKER_ADDR`.

| Worker | Key variables |
|--------|---------------|
| `ch-insert` | `BADGERIQ_KAFKA_BROKERS/_TOPIC/_DLQ_TOPIC`, `BADGERIQ_CONSUMER_GROUP`, `BADGERIQ_INSERT_RETRIES`, `BADGERIQ_RETRY_BACKOFF_MS` |
| `reconcile` | `BADGERIQ_RECONCILE_THRESHOLD`, `BADGERIQ_RECONCILE_LOOKBACK_DAYS`, `BADGERIQ_RECONCILE_INTERVAL_SEC` |
| `risk-engine` | `BADGERIQ_RISK_SPIKE_MIN`, `BADGERIQ_RISK_INTERVAL_SEC` |
| `risk-enrichment` | `BADGERIQ_RISK_ENRICH_ENABLED`, `_LOOKBACK_HOURS`, `_MIN_CALLS`, `_MIN_CONFIDENCE`, `_MODEL`, `_INTERVAL_SEC`, `BADGERIQ_ANTHROPIC_BASE_URL`, 🔒 `ANTHROPIC_API_KEY` |
| `attribution` | `BADGERIQ_ATTR_WINDOW_MIN`, `_LOOKBACK_DAYS`, `_MIN_CONFIDENCE`, `_INTERVAL_SEC`, `ATTRIBUTION_ENGINE_V2`, `ATTRIBUTION_ENGINE_V2_CUTOVER` (default off — V2 stamps outcomes, V1 skipped), 🔒 `BADGERIQ_PG_DSN` (required for V2) |
| `attribution-priors` | 🔒 `BADGERIQ_PG_DSN`, `BADGERIQ_PRIORS_LOOKBACK_DAYS`, `_MIN_CUSTOMER_N`, `_INTERVAL_SEC` |
| `slack-alerter` | 🔒 `BADGERIQ_PG_DSN`, `BADGERIQ_SLACK_ALERT_INTERVAL_SEC`, 🔒 `BADGERIQ_SLACK_WEBHOOK_URL` (unset = off) |

Full tables: `services/workers/README.md`.

## Connectors (`services/connectors`)

`connector-sync` / `outcome-sync`: 🔒 `BADGERIQ_PG_DSN`, the ClickHouse vars,
`BADGERIQ_CONNECTOR_INTERVAL_MS`, `BADGERIQ_CONNECTOR_RETRIES`,
`BADGERIQ_SYNC_INTERVAL_SEC` / `BADGERIQ_OUTCOME_SYNC_INTERVAL_SEC`,
`BADGERIQ_CONNECTOR_ADDR` / `BADGERIQ_OUTCOME_ADDR`. Outcome connector credentials
(e.g. 🔒 `GITHUB_TOKEN`) are referenced by name from `connectors.secret_ref`.

## LiteLLM adapter (`services/ingest/adapters`)

`BADGERIQ_LITELLM_ADAPTER_ADDR`, `BADGERIQ_COLLECTOR_URL`,
`BADGERIQ_ADAPTER_TENANT`, `BADGERIQ_ADAPTER_TENANT_META_KEY`,
`BADGERIQ_MAX_BODY_BYTES`.

## Control-plane API (`services/api`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `NODE_ENV` | _(unset)_ | Set `production` in prod (disables dev auth + Swagger by default). |
| 🔒 `BADGERIQ_PG_DSN` | _(required)_ | Postgres DSN (`agentledger_api` role). Alternatively set `DB_HOST`/`DB_NAME`/`DB_USER`/🔒 `DB_PASSWORD` (+ optional `DB_PORT`, `DB_SSLMODE`; `DB_HOST` may be a `/cloudsql/...` unix socket) — Cloud Run MVP convention. |
| `BADGERIQ_ANALYTICS_BACKEND` | `clickhouse` | Analytics store: `clickhouse` (full stack) or `postgres` (Cloud Run MVP, single database; requires migration `023_analytics_mvp.sql`). |
| ClickHouse vars | — | Analytics reads (unused when `BADGERIQ_ANALYTICS_BACKEND=postgres`). |
| `BADGERIQ_API_ADDR` | `:8094` | Listen address. |
| `BADGERIQ_API_BODY_LIMIT` | `256kb` | Max request body. |
| 🔒 `BADGERIQ_JWT_SECRET` | _(required)_ | Session-JWT HS256 secret (unprefixed `JWT_SECRET` also accepted). |
| `BADGERIQ_JWT_ACCESS_TTL` / `_REFRESH_TTL` | `15m` / `7d` | Token lifetimes. |
| `BADGERIQ_OIDC_REDIRECT_BASE` | `http://localhost:8094` | OIDC callback base URL. |
| 🔒 OIDC client id/secret env vars | _(unset)_ | Per provider; unset → provider unavailable. |
| `BADGERIQ_COOKIE_SAMESITE` | `strict` | Session cookie SameSite (`lax`/`none` for documented cross-site). |
| `BADGERIQ_DASHBOARD_URL` | `http://localhost:3000` | Post-login redirect target. |
| `BADGERIQ_EXPOSE_DOCS` | _(unset)_ | Expose Swagger; required to enable in production. |
| 🔒 `BADGERIQ_DOCS_TOKEN` | _(unset)_ | Bearer for Swagger in production. |
| `BADGERIQ_DEV_TRUST_HEADER` | _(unset)_ | **Dev only.** `x-tenant-id` → dev admin. The API refuses to start in production if set. |
| `BADGERIQ_CONNECTOR_SCHEDULER_ENABLED` | _(true)_ | Set `false` to disable hourly background sync for API connectors. |
| `BADGERIQ_CONNECTOR_SCHEDULER_INTERVAL_MS` | `3600000` | How often the scheduler checks for due connectors (ms). Per-connector interval is `schedule_json.intervalMinutes` (default 60). |

## Dashboard (`apps/dashboard`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `BADGERIQ_API_URL` | `http://localhost:8094` | Control-plane API base (server-side BFF). |
| `BADGERIQ_DEV_TENANT_ID` | _(unset)_ | **Dev only.** Tenant sent via `x-tenant-id`; never sent when `NODE_ENV=production`. |
| `BADGERIQ_DEMO_MODE` | _(unset)_ | `true` shows the "Demo mode" banner (seeded sample data). |

## SDKs

`BADGERIQ_API_KEY` (TypeScript + Python SDKs) — optional ingest auth token,
referenced by name; falls back to `AGENTLEDGER_API_KEY`.
