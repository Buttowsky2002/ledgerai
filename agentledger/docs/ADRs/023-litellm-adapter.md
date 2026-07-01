# ADR-023 — LiteLLM spend-log ingestion adapter

**Date:** 2026-06-19
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Pivot Phase 1 (CLAUDE.md §3, ARCHITECTURE_PIVOT.md Pillar 1); ADR-005 (collector); ADR-022 (OTel ingestion)

---

## Context

The pivot's first job is "connect a source, see value" without requiring our
gateway. LiteLLM is one of the most widely deployed OSS LLM gateways/proxies and
emits a spend log per request (its `/spend/logs` API rows and the
`StandardLoggingPayload` sent to logging callbacks). A customer already running
LiteLLM should get attribution + cost in BadgerIQ in an afternoon by pointing
that log stream at us.

This is the first **spend-log adapter** of the `services/ingest/adapters/`
module the target tree calls for (LiteLLM/Bifrost/Portkey/OpenRouter). OTel
GenAI ingestion was folded into the collector instead (ADR-022); spend-log
adapters are separate because they need format-specific parsing and run as
webhooks/replay jobs, not as a generic HTTP intake.

## Decision

### A thin, stdlib-only adapter that normalizes then forwards

`cmd/litellm` is an HTTP webhook (`POST /ingest/litellm`) that accepts a single
spend-log object or a JSON array, maps each record to a canonical `llm_call`
event in `internal/litellm`, and forwards the batch to the collector's
`/v1/events` via `internal/forward`.

**The collector stays the single validate + produce boundary.** The adapter does
structural normalization and rejects records missing attribution-critical fields
(stable id, start time, resolvable tenant), but the authoritative JSON-Schema
validation happens at the collector — so we don't pull the `jsonschema`
dependency (or a second Redpanda producer) into the adapter, and untrusted
third-party data is gated at exactly one place (CLAUDE.md rule 15, rule 12). The
trade-off is one extra in-cluster HTTP hop, which is negligible for a
log-forwarding path.

### Module is its own stdlib-only Go module

`github.com/agentledger/ingest-adapters` has **zero external dependencies**
(no go.sum). Mapping logic and the collector client are stdlib only. The
Dockerfile mirrors the connectors module: `ARG CMD` selects the binary, so
future adapters (bifrost, portkey, openrouter) are `cmd/<name>` additions.

### Tolerant decoding for format drift

LiteLLM's payload shape varies across versions, so the decoder accepts:
- cost under **`response_cost`** (StandardLoggingPayload) or **`spend`** (SpendLogs row);
- timestamps as an **ISO-8601 string** or a **unix-seconds float** (a `flexTime`
  type handles both);
- optional numerics via pointers, so an absent field never becomes a misleading
  `0` in the canonical event.

### Tenant resolution

The adapter is normally deployed per tenant (`AGENTLEDGER_ADAPTER_TENANT`). For a
multi-tenant LiteLLM, a per-record override is read from the metadata key named
by `AGENTLEDGER_ADAPTER_TENANT_META_KEY` (default `agentledger_tenant_id`). No
resolvable tenant ⇒ the record is rejected (counted, logged), never produced.

### Provenance

Events carry `source:"adapter"` and `call_id` prefixed `litellm:` so they are
distinguishable for cross-source dedup and never collide with gateway/SDK ids.
(The `"adapter"` enum value was added in ADR-022.)

## Alternatives considered

- **Produce straight to Redpanda from the adapter.** Rejected: would duplicate
  the producer, backpressure handling, and — worse — the schema gate, weakening
  the "one validation boundary for untrusted input" guarantee.
- **Pull from LiteLLM's `/spend/logs` on a cursor (like the billing
  connectors).** Deferred: the push/webhook path is simpler, lower-latency, and
  enough to satisfy the Phase 1 acceptance bar. A polling mode can reuse
  `internal/litellm` later for deployments that prefer pull.
- **Validate against the JSON Schema inside the adapter.** Rejected for Phase 1
  (dependency minimalism); the collector already validates. Revisit if adapters
  ever need to short-circuit bad batches before the hop.

## Consequences

- A customer running LiteLLM connects a source and sees cost + attribution
  without changing their stack — the concrete payoff of the gateway-agnostic pivot.
- New module `services/ingest/adapters` wired into Makefile (`GO_SERVICES`,
  `build`), CI (Go matrix entry `ingest/adapters`), and docker-compose
  (`litellm-adapter` service, depends on the collector).
- New env vars documented in the module README.
- Adapter exposes Prometheus counters (received / normalized / rejected /
  forwarded / forward_errors) and health/readiness endpoints.
- Format-drift risk is real and documented; mapping changes are localized to
  `internal/litellm` and covered by tests. The collector's schema is never
  loosened to accommodate a source.
