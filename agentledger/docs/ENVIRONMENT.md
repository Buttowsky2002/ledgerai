# Environment variables

Every variable uses the **`LEDGERAI_*`** prefix. The legacy **`AGENTLEDGER_*`**
names are still read as deprecated aliases (a service prefers `LEDGERAI_*` and
falls back to `AGENTLEDGER_*`), so existing deployments keep working — migrate by
renaming the prefix. See the repo README "Renaming to LedgerAI".

**Secret rule:** config holds env-var *names*, never secret values. Provider keys,
the Redis password, and OIDC client secrets are referenced by the env-var name they
live in. Never commit a secret. For deployment modes see [`DEPLOYMENT.md`](DEPLOYMENT.md);
for an example file see [`.env.example`](../.env.example).

> 🔒 = secret (inject via a secret manager).

## Cross-cutting (most services)

| Variable | Default | Purpose |
|----------|---------|---------|
| `LEDGERAI_CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint. |
| `LEDGERAI_CLICKHOUSE_DB` | `agentledger` | ClickHouse database. |
| `LEDGERAI_CLICKHOUSE_USER` | `default` | ClickHouse user. |
| 🔒 `LEDGERAI_CLICKHOUSE_PASSWORD` | _(empty)_ | ClickHouse password. |
| 🔒 `LEDGERAI_PG_DSN` | _(per service)_ | Postgres DSN; use the non-superuser `agentledger_api` role (RLS). |
| `LEDGERAI_<svc>_WORKER_ADDR` / `_ADDR` | per service | Health/metrics listen address. |

## Gateway (`services/gateway`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `LEDGERAI_CONFIG` | `config.json` | Path to the gateway config file (virtual keys, providers, DLP). |
| 🔒 `LEDGERAI_PG_DSN` | _(unset)_ | Optional: load virtual keys/DLP/tool-allowlist from Postgres (hot reload). Unset = static file config. |
| 🔒 `LEDGERAI_OPS_TOKEN` | _(unset)_ | Bearer required for `/v1/usage` and `/metrics`. Unset in prod → those return 404. |
| `LEDGERAI_ENV` | _(unset)_ | `production` locks ops endpoints when no token is set. |
| `LEDGERAI_ALLOW_UNAUTH_OPS` | _(unset)_ | Dev-only: allow unauthenticated ops access. Never in prod. |
| `LEDGERAI_METRICS_PUBLIC` | _(unset)_ | `true` exposes `/metrics` unauthenticated (trusted private scrape net only). |
| `LEDGERAI_DEFAULT_RESERVE_USD` | `0.01` | Budget hold when a request has no `max_tokens`. |
| `LEDGERAI_BUDGET_FAIL_MODE` | `open` | On a Redis error: `open` (serve) or `closed` (reject). |
| `LEDGERAI_EVENT_SPOOL_DIR` | _(unset)_ | Persist failed event flushes as ndjson (content-free) for replay. |
| `LEDGERAI_EVENT_FAIL_MODE` | `observe_only` | `observe_only` (drop on full buffer, counted) or `strict` (backpressure). |
| 🔒 provider keys | — | Referenced by **name** in the config's `api_key_env` (e.g. `OPENAI_API_KEY`). |
| 🔒 Redis password | — | Referenced by **name** in the config's `redis.password_env`. |

## Collector (`services/ingest/collector` → `services/collector`)

`LEDGERAI_COLLECTOR_ADDR`, `LEDGERAI_KAFKA_BROKERS`, `LEDGERAI_KAFKA_TOPIC`,
`LEDGERAI_EVENT_SCHEMA`, `LEDGERAI_MAX_BODY_BYTES`, `LEDGERAI_MAX_BATCH`,
`LEDGERAI_MAX_INFLIGHT`, `LEDGERAI_OTEL_TENANT_ATTR`, `LEDGERAI_OTEL_DEFAULT_TENANT`.
Full table: `services/collector/README.md`.

## Workers (`services/workers`, one `cmd/` per worker)

Common: the cross-cutting ClickHouse vars + `LEDGERAI_WORKER_ADDR`.

| Worker | Key variables |
|--------|---------------|
| `ch-insert` | `LEDGERAI_KAFKA_BROKERS/_TOPIC/_DLQ_TOPIC`, `LEDGERAI_CONSUMER_GROUP`, `LEDGERAI_INSERT_RETRIES`, `LEDGERAI_RETRY_BACKOFF_MS` |
| `reconcile` | `LEDGERAI_RECONCILE_THRESHOLD`, `LEDGERAI_RECONCILE_LOOKBACK_DAYS`, `LEDGERAI_RECONCILE_INTERVAL_SEC` |
| `risk-engine` | `LEDGERAI_RISK_SPIKE_MIN`, `LEDGERAI_RISK_INTERVAL_SEC` |
| `risk-enrichment` | `LEDGERAI_RISK_ENRICH_ENABLED`, `_LOOKBACK_HOURS`, `_MIN_CALLS`, `_MIN_CONFIDENCE`, `_MODEL`, `_INTERVAL_SEC`, `LEDGERAI_ANTHROPIC_BASE_URL`, 🔒 `ANTHROPIC_API_KEY` |
| `attribution` | `LEDGERAI_ATTR_WINDOW_MIN`, `_LOOKBACK_DAYS`, `_MIN_CONFIDENCE`, `_INTERVAL_SEC`, `ATTRIBUTION_ENGINE_V2`, 🔒 `LEDGERAI_PG_DSN` (V2 shadow) |
| `attribution-priors` | 🔒 `LEDGERAI_PG_DSN`, `LEDGERAI_PRIORS_LOOKBACK_DAYS`, `_MIN_CUSTOMER_N`, `_INTERVAL_SEC` |
| `slack-alerter` | 🔒 `LEDGERAI_PG_DSN`, `LEDGERAI_SLACK_ALERT_INTERVAL_SEC`, 🔒 `LEDGERAI_SLACK_WEBHOOK_URL` (unset = off) |

Full tables: `services/workers/README.md`.

## Connectors (`services/connectors`)

`connector-sync` / `outcome-sync`: 🔒 `LEDGERAI_PG_DSN`, the ClickHouse vars,
`LEDGERAI_CONNECTOR_INTERVAL_MS`, `LEDGERAI_CONNECTOR_RETRIES`,
`LEDGERAI_SYNC_INTERVAL_SEC` / `LEDGERAI_OUTCOME_SYNC_INTERVAL_SEC`,
`LEDGERAI_CONNECTOR_ADDR` / `LEDGERAI_OUTCOME_ADDR`. Outcome connector credentials
(e.g. 🔒 `GITHUB_TOKEN`) are referenced by name from `connectors.secret_ref`.

## LiteLLM adapter (`services/ingest/adapters`)

`LEDGERAI_LITELLM_ADAPTER_ADDR`, `LEDGERAI_COLLECTOR_URL`,
`LEDGERAI_ADAPTER_TENANT`, `LEDGERAI_ADAPTER_TENANT_META_KEY`,
`LEDGERAI_MAX_BODY_BYTES`.

## Control-plane API (`services/api`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `NODE_ENV` | _(unset)_ | Set `production` in prod (disables dev auth + Swagger by default). |
| 🔒 `LEDGERAI_PG_DSN` | _(required)_ | Postgres DSN (`agentledger_api` role). |
| ClickHouse vars | — | Analytics reads. |
| `LEDGERAI_API_ADDR` | `:8094` | Listen address. |
| `LEDGERAI_API_BODY_LIMIT` | `256kb` | Max request body. |
| 🔒 `LEDGERAI_JWT_SECRET` | _(required)_ | Session-JWT HS256 secret. |
| `LEDGERAI_JWT_ACCESS_TTL` / `_REFRESH_TTL` | `15m` / `7d` | Token lifetimes. |
| `LEDGERAI_OIDC_REDIRECT_BASE` | `http://localhost:8094` | OIDC callback base URL. |
| 🔒 OIDC client id/secret env vars | _(unset)_ | Per provider; unset → provider unavailable. |
| `LEDGERAI_COOKIE_SAMESITE` | `strict` | Session cookie SameSite (`lax`/`none` for documented cross-site). |
| `LEDGERAI_DASHBOARD_URL` | `http://localhost:3000` | Post-login redirect target. |
| `LEDGERAI_EXPOSE_DOCS` | _(unset)_ | Expose Swagger; required to enable in production. |
| 🔒 `LEDGERAI_DOCS_TOKEN` | _(unset)_ | Bearer for Swagger in production. |
| `LEDGERAI_DEV_TRUST_HEADER` | _(unset)_ | **Dev only.** `x-tenant-id` → dev admin. The API refuses to start in production if set. |

## Dashboard (`apps/dashboard`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `LEDGERAI_API_URL` | `http://localhost:8094` | Control-plane API base (server-side BFF). |
| `LEDGERAI_DEV_TENANT_ID` | _(unset)_ | **Dev only.** Tenant sent via `x-tenant-id`; never sent when `NODE_ENV=production`. |
| `LEDGERAI_DEMO_MODE` | _(unset)_ | `true` shows the "Demo mode" banner (seeded sample data). |

## SDKs

`LEDGERAI_API_KEY` (TypeScript + Python SDKs) — optional ingest auth token,
referenced by name; falls back to `AGENTLEDGER_API_KEY`.
