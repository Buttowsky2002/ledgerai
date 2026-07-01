-- BadgerIQ ClickHouse migration 005 — outcome graph trace view
--
-- Phase 3 acceptance: `cost -> agent -> outcome -> value` must be queryable with
-- a confidence on every edge. v_outcome_graph is that end-to-end trace — one row
-- per business outcome, joining the agent run that produced it and exposing:
--   * ai_cost_usd        the deterministic incurred_cost edge (run -> cost)
--   * agent_id / user_id the performed_by edge (run -> identity)
--   * business_value_usd the valued_at edge (outcome -> value)
--   * attribution_confidence  the ONLY probabilistic edge (run -> outcome),
--                             filled by the attribution matcher
--   * headline_eligible  attribution_confidence >= 0.5, the same bar the
--                        dashboard/API apply when excluding low-confidence links
--                        from headline aggregates.
--
-- FINAL collapses the matcher's re-inserted outcomes and the ReplacingMergeTree
-- agent_runs, matching the API analytics queries. An unattributed outcome
-- (run_id='') yields ai_cost_usd=0, confidence=0, headline_eligible=0.
--
-- Forward-only; never edit an applied migration.

CREATE OR REPLACE VIEW agentledger.v_outcome_graph AS
SELECT
    o.tenant_id                              AS tenant_id,
    o.outcome_id                             AS outcome_id,
    o.outcome_type                           AS outcome_type,
    o.source_system                          AS source_system,
    o.ts                                     AS outcome_ts,
    o.run_id                                 AS run_id,
    r.agent_id                               AS agent_id,
    r.user_id                                AS user_id,
    r.total_cost_usd                         AS ai_cost_usd,
    o.business_value_usd                     AS business_value_usd,
    o.business_value_usd - r.total_cost_usd  AS net_value_usd,
    o.attribution_confidence                 AS attribution_confidence,
    o.attribution_confidence >= 0.5          AS headline_eligible
FROM agentledger.outcomes AS o FINAL
LEFT JOIN agentledger.agent_runs AS r FINAL
    ON r.tenant_id = o.tenant_id AND r.run_id = o.run_id;
