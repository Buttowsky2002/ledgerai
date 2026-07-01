# ADR-022 — OTel GenAI ingestion (collector)

**Date:** 2026-06-19
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Pivot Phase 1 (CLAUDE.md §3, ARCHITECTURE_PIVOT.md Pillar 1); ADR-005 (ingest collector); `schemas/events/llm_call.schema.json`

---

## Context

The architecture pivot makes the gateway optional and turns ingestion into the
product's front door: "connect a source, see value" without routing traffic
through our gateway. A huge installed base already emits OpenTelemetry GenAI
spans (`gen_ai.*`) via OpenLLMetry, Langfuse, Datadog, or the raw OTel SDK. We
want them to stream telemetry in with **zero code changes**.

The existing collector (`services/collector/`) already validates canonical
`llm_call` events at `POST /v1/events` and produces them to Redpanda
`events.raw`. OTel ingestion should reuse that validate → produce path, not
fork it.

## Decision

### A new endpoint on the existing collector, not a new service

`POST /v1/ingest/otel` accepts an **OTLP/JSON** `ExportTraceServiceRequest`.
Each span carrying GenAI markers (`gen_ai.system` / `gen_ai.request.model` /
`gen_ai.operation.name`) is mapped to a canonical `llm_call` event; spans
without those markers are **skipped, not rejected** (a real trace mixes LLM and
non-LLM spans). Mapped events go through the same schema validation and producer
as every other source via a new shared `produceValidated` helper.

Mapping (gen_ai semantic conventions → canonical event):

| canonical            | OTel attribute(s)                                                        |
|----------------------|--------------------------------------------------------------------------|
| `provider`           | `gen_ai.system`                                                          |
| `request_model`      | `gen_ai.request.model`                                                   |
| `response_model`     | `gen_ai.response.model`                                                  |
| `operation_name`     | `gen_ai.operation.name`                                                  |
| `input_tokens`       | `gen_ai.usage.input_tokens` → falls back to `…prompt_tokens`            |
| `output_tokens`      | `gen_ai.usage.output_tokens` → falls back to `…completion_tokens`       |
| `cost_usd`           | `gen_ai.usage.cost` if present (non-standard); else unset               |
| `call_id`            | span id (→ trace id fallback)                                            |
| `ts` / `latency_ms`  | span start (unix-nano → RFC3339) / (end−start)/1e6                       |
| `status`             | OTel status code 2 (ERROR) → `upstream_error`; else `ok`                |
| `run_id`             | `agentledger.run_id` attr → trace id fallback                           |
| attribution dims     | `agentledger.*` attrs win over `service.name`/`enduser.id`/`deployment.environment` |
| `source`             | constant `"otel"`                                                        |

### Tenant resolution (required field, not present in OTel)

OTel has no tenant concept. We resolve `tenant_id` with precedence
**span attribute → resource attribute → `X-AgentLedger-Tenant` header →
configured default**. The attribute key defaults to `agentledger.tenant_id` and
is overridable via `AGENTLEDGER_OTEL_TENANT_ATTR` so a customer can map an
existing attribute instead of re-instrumenting. A GenAI span with **no
resolvable tenant is dropped** (counted in `collector_otel_spans_no_tenant_total`),
never produced — tenant isolation is non-negotiable (CLAUDE.md rule 3).

### `source` enum extension (additive)

Added `"otel"` and `"adapter"` to the event schema's `source` enum. This is an
**additive, non-breaking** change: existing producers/consumers are unaffected,
and the ClickHouse `source` column is a plain `LowCardinality(String) DEFAULT
'gateway'`, so **no migration is required**. Recorded here rather than gated on a
major version bump because the contract's shape is unchanged (no new field, no
removed/renamed field) — consumers that don't recognize the value treat it as an
opaque provenance label.

### Response semantics

200 on any successful conversion with a compact JSON summary
(`{accepted, rejected_validation, rejected_backpressure, spans_skipped}`); 429
when the only outcome is producer backpressure (OTLP exporters back off and
retry); 400 on an unparseable body.

## Alternatives considered

- **A standalone `otel-genai` adapter service** (as the target tree sketches it
  under `services/ingest/adapters/`). Rejected for Phase 1: OTel ingest is HTTP
  intake that wants the collector's existing validation + producer + backpressure
  gate. Folding it into the collector avoids a second Redpanda producer and a
  network hop. The spend-log adapters (LiteLLM, etc.) — which need format-specific
  parsing and run as webhooks/pollers — remain a separate module (ADR-023).
- **Full OTLP/HTTP response conformance** (protobuf content-type,
  `ExportTraceServiceResponse`/`partialSuccess` schema, `Retry-After`). Deferred:
  most exporters branch only on the 2xx/4xx class. Tracked as future hardening.
- **Computing cost from the price book at ingest.** Rejected for Phase 1: keeps
  the collector free of the price book and DB I/O. OTel cost stays unset unless
  the emitter supplies it; cost derivation happens downstream where the gateway
  and adapters already ground it.

## Consequences

- Anyone emitting `gen_ai.*` OTLP/JSON traces can ingest into BadgerIQ with no
  code changes — the first concrete payoff of the gateway-agnostic pivot.
- The collector gains three Prometheus counters: `collector_otel_spans_converted_total`,
  `collector_otel_spans_skipped_total`, `collector_otel_spans_no_tenant_total`.
- New env vars: `AGENTLEDGER_OTEL_TENANT_ATTR` (default `agentledger.tenant_id`),
  `AGENTLEDGER_OTEL_DEFAULT_TENANT` (default empty = require explicit tenant).
- ch-insert needs no change: OTel events are canonical `llm_call` rows and flow
  through the existing consumer (which already tolerates `source`/extra keys).
- OTLP attribute coverage is intentionally minimal (the fields we map). Emitter
  format drift is a documented risk; the README lists assumptions.
