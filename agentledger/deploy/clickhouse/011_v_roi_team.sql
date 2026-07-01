-- BadgerIQ ClickHouse migration 011 — expose team_id on v_roi
--
-- The dashboard overview adds a team filter. spend_daily / risk_daily / outcomes
-- already carry team_id, but v_roi (migration 006) projected everything EXCEPT
-- team_id, so a team-scoped risk-adjusted-ROI query had nothing to filter on.
-- This re-creates v_roi identically plus `o.team_id AS team_id` (additive; column
-- order preserved, new column appended). v_agent_daily_unit_economics (010) selects
-- named columns from v_roi and is unaffected.
--
-- Forward-only; never edit an applied migration.

CREATE OR REPLACE VIEW agentledger.v_roi AS
WITH
    coalesce(ov.baseline_minutes, rt.baseline_minutes, 0)                       AS base_minutes,
    coalesce(rt.hourly_rate, 0)                                                 AS hourly_rate,
    coalesce(ov.baseline_cost_usd, hourly_rate * base_minutes / 60.0)          AS baseline_value_usd,
    coalesce(rt.rework_pct, 0)                                                  AS rework_pct,
    coalesce(ov.redeployment_factor, rt.redeployment_factor, 1.0)               AS redeployment_factor,
    baseline_value_usd * (1 - rework_pct) * redeployment_factor                 AS computed_value_usd,
    if(o.business_value_usd > 0, o.business_value_usd, computed_value_usd)      AS value_usd,
    coalesce(r.total_cost_usd, 0)                                               AS ai_cost_usd,
    coalesce(ov.qa_cost_usd, rt.qa_cost_per_outcome, 0)                         AS qa_cost_usd,
    coalesce(ov.eval_cost_usd, rt.eval_cost_per_outcome, 0)                     AS eval_cost_usd,
    coalesce(ov.integration_cost_usd, rt.integration_cost_per_outcome, 0)       AS integration_cost_usd,
    ai_cost_usd + qa_cost_usd + eval_cost_usd + integration_cost_usd            AS direct_cost_usd,
    direct_cost_usd * coalesce(ov.platform_overhead_pct, rt.platform_overhead_pct, 0) AS platform_overhead_usd,
    direct_cost_usd + platform_overhead_usd                                     AS fully_loaded_cost_usd,
    o.attribution_confidence                                                    AS confidence,
    coalesce(ar.risk_exposure_pct, 0)                                           AS risk_exposure_pct
SELECT
    o.tenant_id                                              AS tenant_id,
    o.outcome_id                                             AS outcome_id,
    o.outcome_type                                           AS outcome_type,
    o.team_id                                                AS team_id,
    o.ts                                                     AS outcome_ts,
    o.run_id                                                 AS run_id,
    r.agent_id                                               AS agent_id,
    baseline_value_usd,
    value_usd,
    ai_cost_usd,
    qa_cost_usd,
    eval_cost_usd,
    integration_cost_usd,
    platform_overhead_usd,
    fully_loaded_cost_usd,
    confidence                                              AS attribution_confidence,
    risk_exposure_pct,
    value_usd - fully_loaded_cost_usd                       AS nominal_roi_usd,
    value_usd * confidence - fully_loaded_cost_usd          AS expected_roi_usd,
    value_usd * confidence * (1 - risk_exposure_pct) - fully_loaded_cost_usd AS risk_adjusted_roi_usd,
    value_usd * confidence * (1 - risk_exposure_pct) - fully_loaded_cost_usd AS roi_low_usd,
    value_usd - fully_loaded_cost_usd                       AS roi_high_usd,
    confidence >= 0.5                                        AS headline_eligible
FROM agentledger.outcomes AS o FINAL
LEFT JOIN agentledger.agent_runs AS r FINAL
    ON r.tenant_id = o.tenant_id AND r.run_id = o.run_id
LEFT JOIN agentledger.roi_rates AS rt FINAL
    ON rt.tenant_id = o.tenant_id AND rt.source_system = o.source_system AND rt.outcome_type = o.outcome_type
LEFT JOIN agentledger.roi_overrides AS ov FINAL
    ON ov.tenant_id = o.tenant_id AND ov.outcome_id = o.outcome_id
LEFT JOIN agentledger.agent_risk AS ar FINAL
    ON ar.tenant_id = o.tenant_id AND ar.agent_id = r.agent_id
SETTINGS join_use_nulls = 1;
