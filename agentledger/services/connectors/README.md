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

## Adding a provider importer

Implement `Connector` (see `internal/connector/connector.go`), then register it
in `cmd/connector-sync/main.go` → `registeredConnectors()`. Read the provider's
API key from an env var **named** in the connector's `config` JSON (config holds
env-var names, never secrets — CLAUDE.md rule 1). Importers landing next:
OpenAI usage/costs, Anthropic usage, AWS Bedrock, GCP Vertex.

## Run

```bash
cd services/connectors
AGENTLEDGER_PG_DSN='postgres://agentledger:dev_only_change_me@localhost:5432/agentledger?sslmode=disable' \
AGENTLEDGER_CLICKHOUSE_URL=http://localhost:8123 \
go run ./cmd/connector-sync
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTLEDGER_PG_DSN` | _(required)_ | Postgres DSN (connector config + cursor state). |
| `AGENTLEDGER_CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint. |
| `AGENTLEDGER_CLICKHOUSE_DB` | `agentledger` | Target database. |
| `AGENTLEDGER_CLICKHOUSE_USER` / `_PASSWORD` | `default` / _(empty)_ | ClickHouse auth. |
| `AGENTLEDGER_SYNC_INTERVAL_SEC` | `3600` | Seconds between sync passes. |
| `AGENTLEDGER_CONNECTOR_INTERVAL_MS` | `1000` | Min spacing between provider calls. |
| `AGENTLEDGER_CONNECTOR_RETRIES` | `4` | Retry attempts per fetch. |
| `AGENTLEDGER_CONNECTOR_ADDR` | `:8092` | Admin/health listen address. |

See `docs/ADRs/007-connector-framework.md` for design rationale.
