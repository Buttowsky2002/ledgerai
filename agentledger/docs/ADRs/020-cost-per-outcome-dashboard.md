# ADR-020 — Cost-per-Outcome Dashboard + Confidence Threshold

**Date:** 2026-06-18
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 4 (CLAUDE_CODE_BUILD_SPEC.md §3); ADR-013 (analytics over ClickHouse); ADR-018 (attribution matcher)

---

## Context

Phase 4's acceptance bar: a seeded demo shows "cost per resolved ticket" **with confidence**, and
outcomes below a confidence threshold are **visibly excluded from the headline numbers**. The
`/v1/analytics/unit-economics` endpoint already existed (Phase 3) but read the pre-aggregated
`v_unit_economics` view, which `count()/sum()/avg()`s every outcome — so it cannot drop individual
low-confidence outcomes. The attribution matcher (ADR-018) writes `attribution_confidence`
(0 = unattributed) onto each outcome; this task surfaces it as a user-tunable threshold.

## Decision

### Filter server-side on the base tables (with `FINAL`)

`unitEconomics()` is rewritten to query `outcomes`/`agent_runs` directly with an always-bound
`min_confidence` (default 0) and `WHERE o.attribution_confidence >= {minconf:Float32}`, then
aggregate. Filtering must happen **before** aggregation: excluding outcomes client-side would
divide the full AI cost by a reduced outcome count, producing a wrong `cost_per_outcome`. Reads
use `FINAL` to collapse the matcher's re-inserted rows (raw + attributed) to the latest per
`outcome_id` — `agentDetail()` already uses `FINAL` on `agent_runs`, so this is house style. The
`v_unit_economics` view is left defined but is no longer used by this endpoint.

*Rejected:* keeping the view for the unfiltered call and branching to base tables only when
filtering — two query paths to maintain, and the view path keeps the latent
duplicate-row double-count that `FINAL` fixes.

### Discrete threshold buttons

The `/cost-per-outcome` page is a server component; the threshold is a set of header Link buttons
(`0 / 0.3 / 0.5 / 0.7 / 0.9`, default `0.5`) that set `?min=` and re-run the query — identical to
the allocation/settings filter pattern, no client-side state. The page fetches the filtered set
**and** the unfiltered baseline (`minConfidence: 0`) so it can state "including N of M outcomes —
{M−N} excluded below {min}", making the exclusion explicit.

## Consequences

- **Positive**: closes the Phase-4 acceptance bar — cost-per-outcome with a live confidence
  threshold that visibly excludes low-confidence outcomes; numerator and denominator stay
  consistent. `FINAL` also makes the figures correct in the presence of the matcher's re-inserts.
  Endpoint contract is unchanged except for the new optional `minConfidence` (0..1) input;
  response fields stay snake_case.
- **Negative / scope**: `business_value_usd` is whatever's stored on the outcome rows — applying
  ROI templates' `value_formula` to populate it is still not wired (a later seed/step), so
  net-value figures are only meaningful once outcomes carry value. Querying base tables with
  `FINAL` is heavier than the pre-aggregated view; fine at MVP scale, revisit if the outcome
  volume grows.
- **Operational**: regenerate the spec + types after the DTO change (`services/api:
  npm run generate:openapi`, then `packages/shared-types: npm run generate && npm run build`) and
  commit them. e2e requires Postgres + ClickHouse up (`docker compose up -d postgres pg-dev-init
  clickhouse`).
