# ADR-026 — Finance-grade Risk-Adjusted ROI engine

**Date:** 2026-06-19
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 4 (CLAUDE.md); ADR-013 (analytics); ADR-018 (attribution matcher); ADR-019 (ROI template CRUD); ADR-024 (outcome graph)

---

## Context

Phase 4 requires ROI with finance rigor — baseline capture, fully-loaded cost,
redeployment discount, confidence intervals, risk-adjusted ROI, and an auditable
trail — on top of the existing ROI-template CRUD (ADR-019), whose `value_formula`
was stored but never applied.

## Decision

### Engine = the `v_roi` ClickHouse view (migration 006)

ROI is computed live in a view over the graph plus three inputs, not a persisted
snapshot table — consistent with `v_unit_economics`/`v_outcome_graph`, and
traceable to source events via the graph join (`v_roi → outcomes → agent_runs →
llm_calls`), which satisfies the "auditable trail" bar without a new write path.

Inputs:
- **`roi_rates`** (tenant, source_system, outcome_type) — the template defaults,
  projected from Postgres `roi_templates` by the API on create/update
  (best-effort; the template is already committed, so a ClickHouse outage logs
  rather than failing the request).
- **`roi_overrides`** (tenant, outcome_id) — optional per-outcome actuals,
  Nullable so the view does `coalesce(override, rate, default)`. Kept in their
  own table because the attribution matcher re-inserts whole outcome rows and
  would clobber columns added to `outcomes`.
- **`agent_risk`** (tenant, agent_id) — the `risk_exposure_pct` seam, **empty
  until Phase 5**; defaults to 0 (no discount) so risk-adjusted ROI is built and
  traceable now and P5 simply populates the column.

Formula per outcome: `value = baseline (hourly_rate × baseline_minutes) × (1 −
rework_pct) × redeployment_factor` (an explicit `business_value_usd` wins);
`fully_loaded_cost = ai tokens + QA + eval + integration + platform overhead`;
`expected_roi = value × confidence − cost`; `risk_adjusted_roi = value ×
confidence × (1 − risk_exposure_pct) − cost`; with a `[roi_low, roi_high]` band.

### Surface

- `GET /v1/analytics/roi` aggregates `v_roi` per month/outcome_type; the headline
  excludes low-confidence links by default (`minConfidence` 0.5), overridable.
- Dashboard `/cfo` view: risk-adjusted ROI, value + margin, fully-loaded cost,
  run-rate forecast, ROI-by-month chart, and a month × outcome_type table.

### Fully-loaded cost: template config + per-outcome override

`value_formula` gains `redeployment_factor`, `qa/eval/integration_cost_per_outcome`
and `platform_overhead_pct`; `roi_overrides` can override any of them per outcome.

## Consequences

- A risk-adjusted ROI figure is produced and traces fully back to source events
  (e2e-verified), meeting the Phase 4 acceptance bar; RLS fail-closed and OpenAPI
  publication were already in place.
- **Deferred to Phase 5:** the real risk signal that populates `agent_risk`
  (`risk_exposure_pct`), and the CISO governance dashboard view — both need the
  risk engine. The seam and formula are in place, so P5 is additive.
