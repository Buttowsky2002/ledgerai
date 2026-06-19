-- AgentLedger ClickHouse migration 006 — finance-grade ROI engine
--
-- Phase 4 needs ROI with finance rigor: baseline capture, fully-loaded cost,
-- redeployment discount, confidence intervals (propagate attribution_confidence)
-- and risk-adjusted ROI (discount by risk exposure from the P5 risk engine),
-- every figure traceable to source events.
--
-- The engine is the v_roi VIEW (no new write path on the hot tables). Its inputs:
--   * outcomes / agent_runs        — the graph (value side + AI cost side)
--   * roi_rates (tenant,outcome_type) — template defaults projected from Postgres
--                                       roi_templates (the API upserts on CRUD)
--   * roi_overrides (tenant,outcome_id) — optional per-outcome actuals; Nullable
--                                         so coalesce(override, rate, default)
--   * agent_risk (tenant,agent_id) — risk_exposure_pct seam, EMPTY until P5
--                                    fills it (defaults to 0 → no discount yet)
--
-- Overrides live in their own table, NOT on outcomes: the attribution matcher
-- re-inserts whole outcome rows, which would clobber columns added to outcomes.
--
-- Forward-only; never edit an applied migration.

-- ============================================================
-- Template rate projection (CH mirror of Postgres roi_templates)
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.roi_rates
(
    tenant_id                    LowCardinality(String),
    outcome_type                 LowCardinality(String),
    hourly_rate                  Float64 DEFAULT 0,   -- USD/hour of the human task
    baseline_minutes             Float64 DEFAULT 0,   -- pre-agent minutes per unit
    rework_pct                   Float64 DEFAULT 0,   -- fraction needing rework
    redeployment_factor          Float64 DEFAULT 1,   -- 1 full | 0.5 partial | 0 deferred
    qa_cost_per_outcome          Float64 DEFAULT 0,   -- human review
    eval_cost_per_outcome        Float64 DEFAULT 0,   -- eval/monitoring
    integration_cost_per_outcome Float64 DEFAULT 0,   -- amortized connector/integration
    platform_overhead_pct        Float64 DEFAULT 0,   -- platform share, % of direct cost
    updated_at                   DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, outcome_type);

-- ============================================================
-- Per-outcome actuals (override the template rate when known)
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.roi_overrides
(
    tenant_id             LowCardinality(String),
    outcome_id            String,
    baseline_cost_usd     Nullable(Float64),   -- direct pre-agent value of the unit
    baseline_minutes      Nullable(Float64),
    qa_cost_usd           Nullable(Float64),
    eval_cost_usd         Nullable(Float64),
    integration_cost_usd  Nullable(Float64),
    platform_overhead_pct Nullable(Float64),
    redeployment_factor   Nullable(Float64),
    updated_at            DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, outcome_id);

-- ============================================================
-- Risk exposure seam (filled by the Phase 5 risk engine; empty → 0 discount)
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.agent_risk
(
    tenant_id         LowCardinality(String),
    agent_id          String,
    risk_exposure_pct Float32 DEFAULT 0,   -- 0..1, fraction of value at risk
    updated_at        DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, agent_id);

-- ============================================================
-- The ROI engine view
-- ============================================================
-- value:        baseline (human) cost the agent avoided, net of rework, scaled
--               by the redeployment factor; an explicit business_value_usd on
--               the outcome wins when set.
-- fully_loaded: ai token cost + QA + eval + integration + platform overhead.
-- confidence:   expected_roi weights value by attribution_confidence; the
--               [roi_low, roi_high] band is the resulting interval.
-- risk:         risk_adjusted_roi discounts value by agent risk_exposure_pct
--               (0 until P5) — same formula, just a populated column later.
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
    ON rt.tenant_id = o.tenant_id AND rt.outcome_type = o.outcome_type
LEFT JOIN agentledger.roi_overrides AS ov FINAL
    ON ov.tenant_id = o.tenant_id AND ov.outcome_id = o.outcome_id
LEFT JOIN agentledger.agent_risk AS ar FINAL
    ON ar.tenant_id = o.tenant_id AND ar.agent_id = r.agent_id
SETTINGS join_use_nulls = 1;
