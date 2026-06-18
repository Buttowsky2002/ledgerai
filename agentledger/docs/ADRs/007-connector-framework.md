# ADR-007 — Provider-Cost Connector Framework

**Date:** 2026-06-16
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 2 (CLAUDE_CODE_BUILD_SPEC.md §3); ARCHITECTURE.md §9

---

## Context

Phase 2 imports what each provider actually billed and reconciles it against
gateway-observed cost. The spec calls for a "connector framework (cursor-based
incremental sync, per-connector rate limiting, retries with jitter, state in
Postgres `connectors` table)" plus four importers (OpenAI, Anthropic, Bedrock,
Vertex) and a reconciliation worker. The acceptance bar: "connectors replay from
cursor after crash without duplicates."

This ADR covers the **framework** (the foundation); each importer and the
reconciliation worker get their own follow-on work. The framework must make the
hard guarantees — incrementality, crash-safety, idempotency, polite rate
limiting — so importers only implement provider-specific `Fetch`.

---

## Decision

### `Connector` is a stateless, cursor-driven `Fetch`

```
Fetch(ctx, config, cursor) → (Page{Records, Next, Done}, error)
```

All resumable state lives in the `Cursor` (opaque `map[string]any`, persisted as
`connectors.sync_cursor` JSON). Connectors hold no state across calls, so a sync
can crash and resume purely from the persisted cursor. Importers translate
provider payloads into the normalized `Record` (tenant, day, provider, model,
tokens, cost) — nothing downstream knows provider formats.

### Crash-safe ordering: write, *then* save cursor

The Syncer persists the cursor **only after** the page's records are durably
written to the sink. The failure analysis:

- Crash *after* write, *before* cursor save → that page re-fetches and re-writes
  on restart. Safe because `provider_costs` is a `ReplacingMergeTree` ordered by
  the billing line's natural identity `(tenant, day, provider, model, source,
  line_item, virtual_key)` — the duplicate collapses.
- Crash *before* write → page simply re-fetches; nothing was written.

So the pipeline is **at-least-once delivery, effectively-once storage**, which is
exactly the spec's "replay from cursor without duplicates." This is verified by
`TestSyncSinkFailureDoesNotAdvanceCursor` and `TestSyncResumesFromPersistedCursor`
at the framework level (with a mock connector); each importer adds a provider-
specific replay test.

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| Save cursor before write | A crash between would skip an unwritten page → silent data loss. |
| Exactly-once via dedup table / transactions across CH+PG | Heavy and brittle across two stores; the ReplacingMergeTree identity key gives idempotency for free. |
| Offset/“last N days” re-pull every run (no cursor) | Re-imports everything each run; doesn't scale and muddies “incremental.” |

### Destination: ClickHouse `provider_costs` (migration 002)

Imported costs land in a new `provider_costs` `ReplacingMergeTree`, and a
`v_cost_reconciliation` view diffs gateway vs provider per day/model. Writing via
the ClickHouse HTTP `JSONEachRow` interface (stdlib `net/http`, no CH driver)
reuses the ch-insert pattern (ADR-006) and keeps the sink dependency-free. The
reconciliation worker (Phase 2 task 5) reads the view, books adjustments, and
flags drift > 2%.

### State in Postgres `connectors` table

The existing table (`config` JSONB, `sync_cursor` JSONB, `status`,
`last_error`, `last_sync_at`) is the durable record. `PGStore.ListActive`
loads connectors not `disabled`; `SaveCursor`/`MarkSuccess`/`MarkError` persist
progress. The `Store` interface lets the Syncer be unit-tested with an in-memory
store — no Postgres in CI.

### Rate limiting + retries

Per-connector **interval limiter** (steady pacing suits provider usage APIs
better than bursty token buckets) and a **retrier with exponential backoff +
full jitter** (avoids synchronized retry storms across connectors). Both take
injectable clocks/sleep so timing is deterministic in tests.

### Credentials

Importers read the provider key from an env var **named** in the connector's
`config` JSON — config holds env-var names, never secrets (rule 1), mirroring the
gateway's provider-key handling. The `connectors.secret_ref` column anticipates
KMS/vault field-encryption (rule 9); wiring that is deferred to production
hardening and noted here so it isn't re-litigated.

### Service shape

`services/connectors/` is its own module (`cmd/connector-sync` + `internal/
connector`), matching the `workers` layout. Only dependency: `lib/pq` (Postgres).
The ClickHouse sink and rate-limit/retry are stdlib.

---

## Consequences

- **Positive**: Importers implement only `Fetch`; incrementality, crash-safety,
  idempotency, pacing, and retries come from the framework, uniformly tested.
- **Positive**: Reuses the ReplacingMergeTree idempotency model already proven in
  Phase 1 — no new exactly-once machinery.
- **Negative / scope**: No importer ships in this slice, so `connector-sync` is a
  no-op until task 2 registers OpenAI. The framework is fully unit-tested via a
  mock connector, so it is not speculative scaffolding.
- **Negative**: Credentials via env-var-name (not yet KMS field-encryption);
  acceptable for the pilot, tracked against rule 9.
- **Operational**: `connectors` rows are created/managed by the control-plane API
  (Phase 3); until then they are inserted manually for local testing.
