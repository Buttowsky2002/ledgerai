# Workers

Go async consumers of the event bus. One binary per worker under `cmd/`; shared
logic in `internal/`. The first worker is **ch-insert**.

## ch-insert

Consumes the Redpanda topic `events.raw`, batches events, and inserts them into
ClickHouse via the HTTP `JSONEachRow` interface. Routes by event `kind`:

| kind                | target table            |
|---------------------|-------------------------|
| `llm_call` / absent | `agentledger.llm_calls` |
| `agent_run`         | `agentledger.agent_runs`|
| `outcome`           | `agentledger.outcomes`  |
| `tool_call`         | skipped (rolls up into `agent_runs`) |
| unknown / bad JSON  | dead-lettered → `events.dlq` |

### Delivery semantics

- Offsets commit **only after** a batch is durably inserted, so a crash
  re-delivers rather than loses events.
- A whole-batch insert failure is treated as **transient** (ClickHouse down):
  the worker retries in place and does **not** commit — no data loss.
- A row that fails on its own while its batch-mates succeed is **poison**: it is
  dead-lettered to `events.dlq` (with a `dlq-reason` header) and the rest proceed.
- `llm_calls` is a `ReplacingMergeTree` keyed on `(tenant_id, ts, call_id)`, so
  any re-delivery overlap is deduplicated — the pipeline is effectively
  idempotent.

### Run

```bash
cd services/workers
go run ./cmd/ch-insert      # consumes events.raw → ClickHouse at :8123
```

### Endpoints (admin server, default `:8091`)

| Path        | Purpose                                   |
|-------------|-------------------------------------------|
| `/healthz`  | Liveness.                                 |
| `/readyz`   | Readiness — pings ClickHouse and brokers. |
| `/metrics`  | Prometheus text exposition.               |

### Environment variables

| Variable                        | Default                   | Purpose                         |
|---------------------------------|---------------------------|---------------------------------|
| `AGENTLEDGER_KAFKA_BROKERS`     | `localhost:19092`         | Comma-separated broker list.    |
| `AGENTLEDGER_KAFKA_TOPIC`       | `events.raw`              | Source topic.                   |
| `AGENTLEDGER_KAFKA_DLQ_TOPIC`   | `events.dlq`              | Dead-letter topic.              |
| `AGENTLEDGER_CONSUMER_GROUP`    | `ch-insert`               | Consumer group id.              |
| `AGENTLEDGER_CLICKHOUSE_URL`    | `http://localhost:8123`   | ClickHouse HTTP endpoint.       |
| `AGENTLEDGER_CLICKHOUSE_DB`     | `agentledger`             | Target database.                |
| `AGENTLEDGER_CLICKHOUSE_USER`   | `default`                 | ClickHouse user.                |
| `AGENTLEDGER_CLICKHOUSE_PASSWORD` | _(empty)_               | ClickHouse password (secret).   |
| `AGENTLEDGER_WORKER_ADDR`       | `:8091`                   | Admin/metrics listen address.   |
| `AGENTLEDGER_INSERT_RETRIES`    | `3`                       | Per-batch insert retries.       |
| `AGENTLEDGER_RETRY_BACKOFF_MS`  | `250`                     | Base retry/redelivery backoff.  |

See `docs/ADRs/006-clickhouse-insert-worker.md` for the design rationale.

## reconcile

Diffs gateway-observed cost (`llm_calls`, `source=gateway`) against
provider-billed cost (`provider_costs`, from the connectors) via the
`v_cost_reconciliation` view, and books one `cost_adjustments` row per
`(tenant, day, model)`, flagging rows whose `|drift_pct|` exceeds the threshold.

```
llm_calls (gateway) ┐
                    ├─▶ v_cost_reconciliation ─▶ [reconcile] ─▶ cost_adjustments / v_flagged_drift
provider_costs ─────┘
```

- Idempotent: `cost_adjustments` is a `ReplacingMergeTree` keyed on
  `(tenant, day, model)`, so re-runs replace rather than duplicate.
- Rows with no provider cost yet (import lag) are never flagged.
- Reconciles a trailing window each run (default 35 days), so late-arriving
  provider data re-reconciles automatically.

### Run

```bash
cd services/workers
go run ./cmd/reconcile      # reads/writes ClickHouse at :8123, admin on :8093
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTLEDGER_CLICKHOUSE_URL` / `_DB` / `_USER` / `_PASSWORD` | `http://localhost:8123` / `agentledger` / `default` / _(empty)_ | ClickHouse connection. |
| `AGENTLEDGER_RECONCILE_THRESHOLD` | `0.02` | Drift fraction above which a row is flagged. |
| `AGENTLEDGER_RECONCILE_LOOKBACK_DAYS` | `35` | Trailing window reconciled each pass. |
| `AGENTLEDGER_RECONCILE_INTERVAL_SEC` | `86400` | Seconds between passes. |
| `AGENTLEDGER_WORKER_ADDR` | `:8093` | Admin/metrics listen address. |

See `docs/ADRs/009-reconciliation-worker.md` for the design rationale.

## attribution

Correlates business `outcomes` to the `agent_runs` that produced them and stamps
`run_id` + `attribution_confidence` (0..1) back onto the `outcomes` table, so
`v_unit_economics` can join AI cost to each outcome.

```
outcomes (run_id='', conf=0) ┐
                             ├─▶ [attribution] ─▶ outcomes (run_id, attribution_confidence)
agent_runs (completed) ──────┘
```

- Signals: SDK direct link (`agent_runs.outcome_id`) → `1.0`; otherwise
  time-proximity + identity (`user_id`) + issue/branch token in `objective`,
  summed and gated by a minimum confidence.
- Write strategy: re-inserts the full row into the `outcomes` ReplacingMergeTree
  (read with `FINAL`); only rows whose attribution changed are written. Idempotent;
  re-runs heal attribution clobbered by connector re-scans (eventual consistency).
- Re-attributes a trailing window each pass (default 30 days).

### Run

```bash
cd services/workers
go run ./cmd/attribution   # reads/writes ClickHouse at :8123, admin on :8096
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTLEDGER_CLICKHOUSE_URL` / `_DB` / `_USER` / `_PASSWORD` | `http://localhost:8123` / `agentledger` / `default` / _(empty)_ | ClickHouse connection. |
| `AGENTLEDGER_ATTR_WINDOW_MIN` | `240` | Max minutes between a run ending and the outcome. |
| `AGENTLEDGER_ATTR_LOOKBACK_DAYS` | `30` | Trailing window of outcomes re-attributed each pass. |
| `AGENTLEDGER_ATTR_MIN_CONFIDENCE` | `0.3` | Below this an outcome is left unattributed. |
| `AGENTLEDGER_ATTR_INTERVAL_SEC` | `900` | Seconds between passes. |
| `AGENTLEDGER_WORKER_ADDR` | `:8096` | Admin/metrics listen address. |

See `docs/ADRs/018-attribution-matcher.md` for the design rationale.
