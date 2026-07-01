-- BadgerIQ ClickHouse migration 010 — per-agent daily unit economics
--
-- The Outcome Graph MVP needs a single per-agent/day rollup of the cost→outcome
-- economics. Rather than re-derive the ROI math, this view aggregates the finance
-- grade v_roi engine (migration 006) — so confidence weighting, fully-loaded cost,
-- and the risk discount all stay defined in exactly one place.
--
-- Grain: (tenant_id, agent_id, day). One row per agent per UTC day on which that
-- agent's runs produced outcomes. Outcomes with no attributable run (agent_id is
-- NULL via the v_roi LEFT JOIN) are excluded — they cannot be charged to an agent.
--
-- Column meanings (documented because "cost" is overloaded):
--   cost_usd                    raw AI/token cost of the agent's runs (agent spend)
--   outcomes_count              outcomes attributed to the agent that day
--   value_usd                   business value produced
--   net_value_usd               value minus FULLY-LOADED cost (tokens+QA+eval+
--                               integration+platform) — finance-grade, not raw cost
--   cost_per_success            fully-loaded cost per headline-eligible outcome
--                               (attribution_confidence >= 0.5); NULL when none
--   attribution_confidence_avg  mean calibrated confidence of the day's outcomes
--   risk_adjusted_roi           sum of v_roi.risk_adjusted_roi_usd
--
-- Forward-only; never edit an applied migration.

-- Aggregate in an inner query, then do the arithmetic outside it: re-using an
-- aggregate's alias inside another aggregate (e.g. sum(value_usd) AS value_usd
-- then sum(value_usd) again for net) is a nested aggregate (CH error 184).
CREATE OR REPLACE VIEW agentledger.v_agent_daily_unit_economics AS
SELECT
    tenant_id,
    agent_id,
    day,
    cost_usd,
    outcomes_count,
    value_usd,
    value_usd - fully_loaded_cost_usd                AS net_value_usd,
    fully_loaded_cost_usd / nullIf(success_count, 0) AS cost_per_success,
    attribution_confidence_avg,
    risk_adjusted_roi
FROM
(
    SELECT
        tenant_id,
        agent_id,
        toDate(outcome_ts)            AS day,
        sum(ai_cost_usd)              AS cost_usd,
        count()                       AS outcomes_count,
        sum(value_usd)               AS value_usd,
        sum(fully_loaded_cost_usd)    AS fully_loaded_cost_usd,
        countIf(headline_eligible)    AS success_count,
        avg(attribution_confidence)   AS attribution_confidence_avg,
        sum(risk_adjusted_roi_usd)    AS risk_adjusted_roi
    FROM agentledger.v_roi
    WHERE agent_id != ''
    GROUP BY tenant_id, agent_id, day
)
ORDER BY tenant_id, agent_id, day;
