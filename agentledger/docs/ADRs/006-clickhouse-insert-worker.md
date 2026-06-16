# ADR-006 — ClickHouse Insert Worker

**Date:** 2026-06-16
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 1, task 6 (CLAUDE_CODE_BUILD_SPEC.md §3); ARCHITECTURE.md §6, §9

---

## Context

The collector lands validated events on the Redpanda topic `events.raw`. Phase 1
closes the data plane with a worker that "consumes `events.raw`, batches
JSONEachRow inserts to ClickHouse, dead-letters poison messages." This completes
the acceptance path: **SDK event → collector → Redpanda → ClickHouse row**.

The worker must not lose events on a ClickHouse outage, must not stall forever on
a single bad row, and must keep the gateway's stdlib-light philosophy where it
can.

---

## Decision

### Insert via the ClickHouse HTTP `JSONEachRow` interface (no CH client lib)

The worker POSTs the raw event JSON — exactly as produced — to
`/?query=INSERT INTO <db>.<table> FORMAT JSONEachRow`. ClickHouse maps JSON keys
to columns, applies defaults for missing ones, and (with
`input_format_skip_unknown_fields=1`) ignores envelope keys like `kind`/`source`.
`date_time_input_format=best_effort` parses the SDK's ISO-8601 `ts`.

This needs only stdlib `net/http` — no ClickHouse driver dependency — and the
architecture already anticipates it ("the same JSONEachRow payload can also be
POSTed directly to ClickHouse"). The only external dependency is the Kafka
consumer (`franz-go`), already justified for the collector (ADR-005).

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| `clickhouse-go` v2 native client | A heavier dependency for what is a single POST of bytes we already hold as JSON; the native protocol's typed columns buy nothing when the payload is schemaless JSON. |
| Re-marshal events into typed Go structs then insert | Re-encodes the contract in Go, duplicating the schema and risking drift; passing bytes through keeps the event schema single-sourced. |

### Routing by `kind` to a fixed table allowlist

`route(kind)` maps `llm_call`/absent → `llm_calls`, `agent_run` → `agent_runs`,
`outcome` → `outcomes`; `tool_call` is skipped (it rolls up into
`agent_runs.tool_calls`); anything else is dead-lettered. Table names are
compile-time constants checked by `isKnownTable` before they reach the SQL
string — table identifiers can't be query-parameterized, so a fixed allowlist is
how the insert stays injection-safe (CLAUDE.md rule 4).

### Delivery: commit-after-insert, transient-vs-poison discrimination

Offsets commit **only after** a batch is durably inserted (`DisableAutoCommit`),
so a crash re-delivers rather than loses events. The hard part is telling a
transient outage (ClickHouse down — must retry, never drop) from a poison row
(bad data — must isolate, never block the partition). The flush algorithm:

1. Insert the whole batch (with a few retries + backoff).
2. On failure, **isolate**: insert each row individually.
3. If **every** row fails → treat as transient (ClickHouse unreachable): return
   an error so the consumer retries the batch without committing. Nothing is
   dead-lettered.
4. If **some** rows fail while others succeed → the failing rows are poison:
   dead-letter them to `events.dlq` (with a `dlq-reason` header) and commit.

`ReplacingMergeTree` on `(tenant_id, ts, call_id)` is the safety net: any row
re-inserted across a retry/redelivery is deduplicated, so the at-least-once
consumer yields effectively-once rows.

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| Dead-letter the whole batch on any failure | A single ClickHouse blip would dump live traffic to the DLQ — data loss disguised as handling. |
| Auto-commit offsets | Events between the last commit and a crash would be lost; insertion is not idempotent without the dedup key working in our favor. |
| Block forever on the first poison row | One malformed event would halt a partition indefinitely (head-of-line blocking). |

### Structure: `cmd/ch-insert` + `internal/chinsert`

Per the repo convention ("one cmd per worker"), the binary is `cmd/ch-insert`
and the logic lives in `internal/chinsert` (config, router, inserter, pipeline,
consumer). The `Inserter` and `DeadLetterer` interfaces let the pipeline — where
all the retry/poison logic lives — be unit-tested with mocks and no live Kafka
or ClickHouse. When the second consumer worker lands (reconciliation, Phase 2),
the franz-go consume loop will be extracted to a shared `internal/bus` package.

### Observability

An admin HTTP server exposes `/healthz`, `/readyz` (pings ClickHouse + brokers),
and `/metrics` (rows inserted, skipped, dead-lettered, insert errors) — hand-
rolled Prometheus text, no client dependency, matching the collector.

---

## Consequences

- **Positive**: No event loss on a ClickHouse outage (retry-without-commit); no
  partition stall on poison data (isolate to DLQ); effectively-once rows via the
  ReplacingMergeTree dedup key.
- **Positive**: Zero ClickHouse-specific dependencies — inserts are plain HTTP.
- **Positive**: Closes the Phase 1 acceptance path; covered by
  `tests/e2e/test_pipeline.py` (SDK → collector → Redpanda → ClickHouse row).
- **Negative / scope**: `agent_run`/`outcome` are inserted on a best-effort
  field-mapping basis (skip-unknown + best-effort dates); their formal schemas
  and stricter validation arrive with the Phase 3 API write paths.
- **Operational**: A poison row in `events.dlq` needs a triage/replay tool
  (future runbook). The `dlq-reason` header is the first triage signal.
- **Throughput**: One insert per poll-batch per table. If batch sizes prove
  small under low traffic, add time/size-based accumulation across polls — the
  consume loop is the single place to change.
