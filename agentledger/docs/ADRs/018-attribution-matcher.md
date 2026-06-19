# ADR-018 — Attribution-Matcher Worker

**Date:** 2026-06-18
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 4 (CLAUDE_CODE_BUILD_SPEC.md §3); ADR-016 (outcome connectors); ADR-009 (reconciliation worker)

---

## Context

`v_unit_economics` (the cost-per-outcome headline) LEFT JOINs `outcomes` to `agent_runs` on
`run_id` and averages `attribution_confidence`. The outcome connectors (ADR-016, tasks 1–2)
deliberately emit `run_id=''` and `attribution_confidence=0` — so today every outcome is
unattributed and contributes zero AI cost. Phase 4 task 3 adds the worker that correlates each
outcome to the agent run that produced it and fills those two fields. Task 5's dashboard then
excludes low-confidence outcomes from headline numbers (the phase acceptance bar).

The worker is purely additive in the `github.com/agentledger/workers` module, mirroring the
reconciliation worker (ADR-009): a periodic ClickHouse read → compute → write loop over stdlib
HTTP, unit-tested behind a `CHClient` interface.

## Decision

### Matching signals + confidence (0..1)

Per pass, per tenant, over a trailing `lookback_days` window of outcomes:

1. **Direct link** — a run with `agent_runs.outcome_id == outcome.outcome_id` is an SDK-asserted
   link → `confidence = 1.0`.
2. **Heuristic** — among completed runs that ended within `window` before the outcome:
   `0.4·timeProximity + 0.4·identity(user_id) + 0.2·issueToken(in objective)`, capped at `0.99`;
   highest-scoring run wins (tie-break: latest `ended_at`). The issue token is the `outcome_id`
   suffix (e.g. `PROJ-123`, `acme/web#42`, `#42`), kept only when ≥3 chars so bare short numbers
   don't false-match free-text objectives.
3. Below `min_confidence` (default `0.3`) or no candidate → left unattributed (`run_id=''`,
   `confidence=0`). This is exactly the signal task 5's threshold filter keys off.

Window, lookback, and min-confidence are env vars (`AGENTLEDGER_ATTR_*`); weights are code
constants. Per-tenant `roi_templates.attribution` (`{window_minutes, match_on}`) wiring is
**deferred to task 4**, which builds that CRUD — task 3 stays self-contained with no Postgres
dependency.

### Write strategy: re-insert the full row (chosen)

The matcher reads outcomes with `FINAL` (merged-latest), recomputes attribution, and re-inserts
the **entire** outcome row (other columns untouched, e.g. `business_value_usd`) via
`INSERT … FORMAT JSONEachRow` — the same approach as `reconcile.WriteAdjustments`. The `outcomes`
ReplacingMergeTree (`ORDER BY (tenant_id, ts, outcome_id)`, no version column) collapses each key
to the last-inserted row, so the matcher row wins until the next connector re-scan; the following
matcher pass restores it (eventual consistency). Only rows whose `(run_id, confidence)` actually
changed are written (a Float32-noise epsilon prevents churn).

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| `ALTER TABLE … UPDATE` mutation | ClickHouse mutations are async and rewrite whole parts — not built for frequent per-row updates; and a later connector re-insert still adds an un-mutated duplicate row. Diverges from every other worker here. |
| Add a version column / `ReplacingMergeTree(version)` with tiered writes | Deterministic (attributed beats raw), but forces a forward migration on `outcomes` **and** editing the shipped GitHub/Jira/Zendesk connectors + `OutcomeSink` to stamp version 0 — against the "don't touch tasks 1–2" grain (ADR-016). |
| Read `roi_templates` for per-tenant config now | Couples task 3 to task 4's data model before that CRUD exists; env defaults are enough for the matcher and the seeded demo. |

## Consequences

- **Positive**: `v_unit_economics` gets real attributed AI cost; the matcher is additive
  (no schema, connector, or reconcile/ch-insert changes), idempotent, and self-healing against
  connector re-scans. Reuses the ADR-009 worker shape (admin `:8096`, `/healthz` `/readyz`
  `/metrics`, ticker loop).
- **Negative / scope**: heuristic weights and the window are fixed in code/env, not yet
  per-tenant (task 4); time-only matches at the exact run-end moment can reach `0.4` and clear
  the default `0.3` threshold — tune `AGENTLEDGER_ATTR_MIN_CONFIDENCE` or the dashboard threshold
  if over-attribution appears. Re-attributing the full window each pass is O(outcomes×runs in
  window) in Go; fine at MVP scale, revisit with per-tenant blocking if needed.
- **Operational**: a new `attribution` worker/binary (admin `:8096`); no new dependencies
  (stdlib only). Live seeded-demo verification (non-zero confidence end-to-end) lands with task 5.
