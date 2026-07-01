# ADR-005 — Ingest Collector Service

**Date:** 2026-06-16
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 1, task 5 (CLAUDE_CODE_BUILD_SPEC.md §3); ARCHITECTURE.md §9

---

## Context

SDK clients and the gateway need a single ingest endpoint that accepts events,
validates them against the canonical contract, and lands them on the event bus
for async enrichment and ClickHouse insertion. The Phase 1 spec is specific:
"HTTP ingest for SDK events, validates against `schemas/events/`, writes to
Redpanda topic `events.raw`, returns 202. Backpressure → 429, never blocks."

This is the first service to need a Kafka client and JSON Schema validation —
neither of which the stdlib-only gateway carries. It is also the first consumer
of the canonical event schema, which did not yet exist as a file.

---

## Decision

### Create the canonical schema `schemas/events/llm_call.schema.json`

The event schema is the contract between SDK, gateway, collector, workers, and
ClickHouse (CLAUDE.md: "single event schema shared by all producers and
consumers"). It is authored from the union of the gateway `LLMCallEvent` struct,
the ClickHouse `llm_calls` columns, and the SDK `record_llm_call` payload.
Required fields are the minimal row identity (`call_id`, `ts`, `tenant_id`);
everything else is optional (blocked events have no provider; SDK events omit
gateway-only fields).

**`additionalProperties: false` is a security control, not a style choice.** The
schema has no field for raw prompt/completion content, and rejecting unknown
fields means a payload carrying a `prompt`/`completion` field is refused at the
ingest boundary — enforcing CLAUDE.md rule 2 structurally rather than by
convention. A test (`TestIngestRejectsRawContentField`) locks this in.

### Validation routing by `kind`

Only `llm_call` is canonical in Phase 1. The validator routes by the `kind`
discriminator: absent or `llm_call` → strict JSON Schema validation; the other
SDK kinds (`agent_run`, `outcome`, `tool_call`) → minimal envelope check
(`tenant_id` + `ts`) pending their own schemas; unknown kinds → rejected. This
keeps the SDK's run/outcome posting working end-to-end without prematurely
freezing schemas the spec hasn't defined yet.

### Non-blocking backpressure model

The hot requirement is "never block; 429 on backpressure." The collector does
**not** buffer in an unbounded queue. The producer exposes `TryProduce`, which
either accepts a record for async delivery or returns `ErrBackpressure`
immediately; the handler maps that to HTTP 429. Backpressure is gated by an
atomic in-flight counter (`BADGERIQ_MAX_INFLIGHT`, default 8192) kept below
the franz-go internal buffer limit, so `kgo.Produce` itself never blocks. The
ingest path therefore has a hard, bounded memory ceiling and constant-time
behavior under overload.

Per-request outcome → status mapping: any accepted → **202**; otherwise only
backpressure → **429**; otherwise all-invalid → **422**; unparseable → **400**.
Partial batches return 202 with a `{accepted, rejected_validation,
rejected_backpressure}` summary — nothing fails silently (rule 11).

### Producer behind an interface

`Producer` (`TryProduce`/`Stats`/`Ready`/`Close`) mirrors the gateway's
`BudgetStore`/`ConfigStore` pattern: the franz-go `KafkaProducer` is the
production impl, and a `mockProducer` drives the handler tests (including a
forced-full mode to assert 429) with no Kafka in CI. Events are keyed by
`tenant_id` so all of a tenant's events land on one partition — ordered and
aligned with the `llm_calls` ReplacingMergeTree dedup key.

### Dependencies (justified per rule 3)

The stdlib-only constraint is the *gateway's* (rule 12, "the data plane"); the
collector is a separate service and may take dependencies with justification.

| Dependency | Why |
|---|---|
| `github.com/twmb/franz-go` | Pure-Go Kafka/Redpanda client, no CGO/librdkafka. Async produce with internal batching + retries fits the non-blocking model. Redpanda-recommended. |
| `github.com/santhosh-tekuri/jsonschema/v5` | Pure-Go, draft 2020-12, format assertions. Validating against the actual schema file keeps the contract single-sourced rather than re-encoded in Go structs. |

Both are pure Go, so the distroless `static` nonroot image and `CGO_ENABLED=0`
build carry over from the gateway unchanged.

### Observability

`/metrics` exposes a hand-written Prometheus text exposition (requests,
accepted, rejected-validation, rejected-backpressure, produced, failed,
in-flight) — no Prometheus client dependency for a flat counter surface.
`/healthz` is liveness; `/readyz` pings the brokers.

---

## Consequences

- **Positive**: Raw content cannot enter the pipeline — enforced by the schema
  boundary and covered by a test.
- **Positive**: Overload degrades to 429 with bounded memory; the caller (SDK is
  fire-and-forget; gateway sink drops with a metric) never blocks on the bus.
- **Positive**: Schema is now a real file — the single source of truth the CH
  insert worker (task 5) and future producers compile against.
- **Negative / scope**: `agent_run`/`outcome`/`tool_call` get only envelope
  validation until their schemas are authored. Documented; tracked for Phase 3
  when those tables get API write paths.
- **Negative**: 202 means "validated and enqueued," not "durably committed to
  the bus." Failed produces increment `collector_records_failed_total`;
  end-to-end durability is verified by the task-5 e2e (SDK → collector →
  Redpanda → ClickHouse) and backstopped by provider reconciliation.
- **Operational**: `events.raw` is auto-created (producer + Redpanda default).
  Production should pre-create it with explicit partitions/retention.
