# ADR-009 — Reconciliation Worker

**Date:** 2026-06-16
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 2 (CLAUDE_CODE_BUILD_SPEC.md §3); ADR-006, ADR-007

---

## Context

Phase 2's capstone diffs gateway-observed cost against provider-billed cost
(imported by the connectors), "books adjustment events, flags drift > 2%." The
acceptance bar: "reconciliation report query returns per-day drift."

Two cost sources now coexist in ClickHouse: `llm_calls` (gateway, per-call) and
`provider_costs` (connectors, per provider billing line). The worker must turn
their difference into a durable, queryable, idempotent record.

---

## Decision

### Reconcile in SQL via `v_cost_reconciliation`, book into `cost_adjustments`

The diff lives in the `v_cost_reconciliation` view (migration 002): a FULL OUTER
JOIN of gateway and provider cost aggregated per `(tenant, day, model)`, yielding
`drift_usd` and `drift_pct`. The worker:

1. Queries the view for the last `lookback` days (default 35) — the date bound is
   a ClickHouse server parameter (`{since:Date}`), never concatenated (rule 4).
2. Flags each row where `|drift_pct| > threshold` (default 2%); rows with no
   provider cost yet (`provider_cost_usd == 0`) are never flagged — the connector
   simply hasn't imported that day, which isn't drift.
3. Writes one `cost_adjustments` row per `(tenant, day, model)` (migration 003).

Doing the heavy aggregation in ClickHouse (not in Go) keeps the worker a thin
read-flag-write loop and leverages the columnar engine for the scan.

### Idempotency via ReplacingMergeTree

`cost_adjustments` is a `ReplacingMergeTree(reconciled_at)` ordered by
`(tenant, day, model)`. Re-running reconciliation for a day **replaces** its
adjustment rather than duplicating it — so the worker can run as often as
desired (daily by default) and a re-run is always safe. `v_flagged_drift`
exposes just the material drift with `FINAL` so superseded re-runs collapse.

### Placement: a worker `cmd`, ClickHouse-only

Per the repo layout ("services/workers … reconciliation … one cmd per worker"),
this is `services/workers/cmd/reconcile` over `internal/reconcile`, reusing the
workers module. It reads and writes ClickHouse over HTTP (stdlib, same as
ch-insert) — no new dependency. The `CHClient` interface (Reconciliation +
WriteAdjustments) lets the flag/threshold logic be unit-tested with a mock, with
a separate HTTP-client test covering the SQL/param wiring.

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| Compute the diff in Go (pull both tables, join in memory) | Throws away ClickHouse's aggregation; doesn't scale and duplicates the view logic. |
| Emit adjustments to the event bus → ch-insert | Adds a hop for low-volume daily aggregates; a direct idempotent upsert is simpler and the data isn't per-call. |
| Append-only adjustments (MergeTree) | Re-runs would pile duplicate rows; ReplacingMergeTree gives clean idempotent re-reconciliation. |

### Granularity: day/model (tenant-scoped)

The spec says "per day/model/key," but reliable key attribution isn't available
across all providers (OpenAI exposes `project_id`; Bedrock/Vertex don't). The
robust common denominator is `(tenant, day, model)`. Key-level reconciliation is
a future refinement where the provider exposes it (recorded here, not built).

---

## Consequences

- **Positive**: Satisfies the acceptance criterion — `v_cost_reconciliation`
  returns per-day drift and `cost_adjustments` / `v_flagged_drift` persist the
  flagged material drift. Validated live: a seeded 5%/1% pair produced exactly
  one flagged adjustment, and a double run stayed deduplicated.
- **Positive**: Idempotent and cheap — safe to run daily (or more often); zero
  new dependencies.
- **Negative / scope**: Reconciles at day/model, not per virtual key; flags but
  does not auto-correct (booking an adjustment record is the "event"). Both are
  intentional for the pilot.
- **Operational**: Connector import lag means today's row reads as 100% drift
  until the provider bills; the `provider_cost == 0 → not flagged` rule keeps that
  from alarming, and the day re-reconciles automatically once data lands.
- **Lesson**: the day-column alias collision (`toString(day) AS day` shadowing the
  `WHERE day >= {since:Date}` Date column) only surfaced against real ClickHouse —
  reinforcing live validation alongside mock-based unit tests.
