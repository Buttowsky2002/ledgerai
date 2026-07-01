# Connectors

Provider-cost importers and the framework that runs them. Each connector pulls
what a provider *actually billed* (incrementally, by cursor) and writes
normalized rows to ClickHouse `agentledger.provider_costs`, which the
reconciliation worker diffs against gateway-observed cost.

```
provider usage/billing API ──▶ connector (Fetch) ──▶ Syncer ──▶ provider_costs (ClickHouse)
                                                        │
                                  Postgres connectors table (config + cursor + status)
```

## Framework

| Piece | Responsibility |
|-------|----------------|
| `Connector` | `Fetch(ctx, config, cursor) → Page` — provider-specific, stateless across calls (all resume state in the cursor) |
| `Syncer` | pages through a connector; rate-limits, retries; **persists the cursor only after the sink write succeeds** |
| `Store` (`PGStore`) | loads connector config/cursor/status from the Postgres `connectors` table; saves cursor + status |
| `RateLimiter` | minimum interval between provider calls (per connector) |
| `Retrier` | exponential backoff + full jitter on transient provider errors |
| `Sink` (`ClickHouseSink`) | HTTP `JSONEachRow` insert into `provider_costs` |

### Crash-safe incremental sync

The cursor is saved **after** a page's records are written, never before. So a
crash mid-page re-fetches and re-writes at most that one page on restart; the
`provider_costs` `ReplacingMergeTree` (ordered by the billing line's natural
identity) collapses the duplicate. Result: **replay from cursor without
duplicates** — at-least-once delivery, effectively-once storage.

## Importers

| Kind (`connectors.kind`) | Source | Auth | Key `config` fields |
|--------------------------|--------|------|---------------------|
| `openai_usage`   | OpenAI Costs API (`/v1/organization/costs`) | Bearer admin key | `api_key_env`, `base_url`, `lookback_days` |
| `anthropic_usage`| Anthropic Cost Report (`/v1/organizations/cost_report`) | `x-api-key` + `anthropic-version` | `api_key_env`, `anthropic_version`, `lookback_days` |
| `bedrock`        | AWS Cost Explorer `GetCostAndUsage` (SigV4) | `AWS_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` (+ optional `_SESSION_TOKEN`) | `access_key_env`, `secret_key_env`, `region`, `service_name` |
| `vertex`         | GCP BigQuery billing export (`jobs.query`) | OAuth2 bearer token | `project_id`, `billing_table`, `token_env`, `service_filter` |

`config` holds env-var **names**, never secret values (CLAUDE.md rule 1).
Per-tenant connector rows live in the Postgres `connectors` table; the
control-plane API manages them (Phase 3), or insert them manually for local dev.

## Outcome connectors (Phase 4)

A parallel path imports **business outcomes** (not costs) into the ClickHouse
`outcomes` table, for the ROI engine. It reuses the same framework helpers
(cursor/rate-limit/retry/Postgres state) via `OutcomeConnector` / `OutcomeSyncer`
/ `ClickHouseOutcomeSink` (`internal/connector/outcome.go`, `sink_outcome.go`),
and runs in its own binary `cmd/outcome-sync` (admin `:8095`). The cost path is
untouched. Connectors emit a **stable `outcome_id`** so re-scans collapse under the
`outcomes` ReplacingMergeTree; `run_id`/`attribution_confidence`/`business_value_usd`
are filled later by the attribution matcher and ROI templates.

| Kind (`connectors.kind`) | Source | Auth | Key `config` fields |
|--------------------------|--------|------|---------------------|
| `github` | GitHub REST `/repos/{repo}/pulls` (merged PRs → `pr_merged`) | Bearer PAT | `repo` (`owner/name`), `token_env`, `lookback_days` |
| `jira` | Jira Cloud REST `/rest/api/3/search` (Done issues → `issue_closed`) | Basic `email:token` | `base_url`, `email_env`, `token_env`, `project`, `lookback_days` |
| `zendesk` | Zendesk Search API `/api/v2/search.json` (solved tickets → `ticket_resolved`) | Basic `email:token` | `base_url`, `email_env`, `token_env`, `lookback_days` |

## Adding a provider importer

Cost importer: implement `Connector` (`internal/connector/connector.go`) — just the
provider-specific `Fetch` (the framework stamps tenant/source and handles
cursor/rate-limit/retry/idempotency) — then register it in
`cmd/connector-sync/main.go` → `registeredConnectors()`.

Outcome importer: implement `OutcomeConnector` and register it in
`cmd/outcome-sync/main.go` → `registeredOutcomeConnectors()`.

## Run

```bash
cd services/connectors
BADGERIQ_PG_DSN='postgres://agentledger:dev_only_change_me@localhost:5432/agentledger?sslmode=disable' \
BADGERIQ_CLICKHOUSE_URL=http://localhost:8123 \
go run ./cmd/connector-sync
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `BADGERIQ_PG_DSN` | _(required)_ | Postgres DSN (connector config + cursor state). |
| `BADGERIQ_CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint. |
| `BADGERIQ_CLICKHOUSE_DB` | `agentledger` | Target database. |
| `BADGERIQ_CLICKHOUSE_USER` / `_PASSWORD` | `default` / _(empty)_ | ClickHouse auth. |
| `BADGERIQ_SYNC_INTERVAL_SEC` | `3600` | Seconds between sync passes. |
| `BADGERIQ_CONNECTOR_INTERVAL_MS` | `1000` | Min spacing between provider calls. |
| `BADGERIQ_CONNECTOR_RETRIES` | `4` | Retry attempts per fetch. |
| `BADGERIQ_CONNECTOR_ADDR` | `:8092` | Admin/health listen address (connector-sync). |
| `BADGERIQ_OUTCOME_SYNC_INTERVAL_SEC` | `3600` | Seconds between outcome sync passes. |
| `BADGERIQ_OUTCOME_ADDR` | `:8095` | Admin/health listen address (outcome-sync). |

See `docs/ADRs/007-connector-framework.md` (cost) and
`docs/ADRs/016-outcome-connectors.md` (outcomes) for design rationale.
