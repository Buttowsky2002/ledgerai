-- AgentLedger ClickHouse migration 004 — per-key reconciliation granularity
--
-- The P2 spec reconciles cost drift "per day/model/key". Providers differ on
-- whether they expose the key: OpenAI's Costs API attributes spend to a project
-- (mapped to virtual_key_id); Anthropic, Bedrock and Vertex bill at model level
-- and leave virtual_key_id=''.
--
-- So we reconcile at PROVIDER GRAIN: per key where the provider breaks cost out
-- by key, and rolled up to virtual_key_id='' (model level) where it does not.
-- Crucially, the gateway side is also collapsed to '' for any (tenant,day,model)
-- the provider did NOT key out — otherwise a key-less provider would show false
-- drift, with gateway cost split across virtual keys while the single provider
-- row sits under ''.
--
-- Forward-only; never edit an applied migration.

-- ============================================================
-- 1. Extend the booked-adjustment identity with the key dimension.
--    Two ClickHouse constraints shape this single ALTER:
--      * ADD COLUMN and MODIFY ORDER BY must be in ONE statement — a column
--        added by a prior statement counts as "existing" and is rejected.
--      * the new key column must NOT carry an explicit DEFAULT expression
--        (only the implicit type default is allowed in a sorting key). For
--        LowCardinality(String) that implicit default is '' — exactly the
--        "key-less / model-level" sentinel we want.
--    Appending to the sort key keeps existing prefix ordering; new inserts
--    dedup per (tenant, day, model, virtual_key_id).
-- ============================================================
ALTER TABLE agentledger.cost_adjustments
    ADD COLUMN IF NOT EXISTS virtual_key_id LowCardinality(String) AFTER model,
    MODIFY ORDER BY (tenant_id, day, model, virtual_key_id);

-- ============================================================
-- 2. Reconciliation view at provider grain (gateway-observed vs provider-billed).
-- ============================================================
CREATE OR REPLACE VIEW agentledger.v_cost_reconciliation AS
WITH
    pv AS
    (
        SELECT
            tenant_id,
            day,
            model,
            virtual_key_id,
            sum(cost_usd) AS provider_cost_usd
        FROM agentledger.provider_costs
        FINAL
        GROUP BY tenant_id, day, model, virtual_key_id
    ),
    -- (tenant,day,model) combinations the provider actually broke out by key.
    keyed AS
    (
        SELECT DISTINCT tenant_id, day, model
        FROM pv
        WHERE virtual_key_id != ''
    ),
    gw_raw AS
    (
        SELECT
            tenant_id,
            toDate(ts)                                          AS day,
            if(response_model != '', response_model, request_model) AS model,
            virtual_key_id,
            sum(cost_usd)                                       AS gateway_cost_usd
        FROM agentledger.llm_calls
        WHERE source = 'gateway' AND status = 'ok'
        GROUP BY tenant_id, day, model, virtual_key_id
    ),
    -- Collapse gateway key to '' for models the provider did not key out, so the
    -- comparison is like-for-like with whatever grain the provider reported.
    gw AS
    (
        SELECT
            g.tenant_id                                  AS tenant_id,
            g.day                                        AS day,
            g.model                                      AS model,
            if(isNotNull(k.model), g.virtual_key_id, '') AS virtual_key_id,
            sum(g.gateway_cost_usd)                      AS gateway_cost_usd
        FROM gw_raw AS g
        LEFT JOIN keyed AS k
            ON g.tenant_id = k.tenant_id AND g.day = k.day AND g.model = k.model
        GROUP BY g.tenant_id, g.day, g.model, virtual_key_id
    )
SELECT
    coalesce(gw.tenant_id, pv.tenant_id)              AS tenant_id,
    coalesce(gw.day, pv.day)                          AS day,
    coalesce(gw.model, pv.model)                      AS model,
    coalesce(gw.virtual_key_id, pv.virtual_key_id)    AS virtual_key_id,
    coalesce(gw.gateway_cost_usd, 0)                  AS gateway_cost_usd,
    coalesce(pv.provider_cost_usd, 0)                 AS provider_cost_usd,
    provider_cost_usd - gateway_cost_usd              AS drift_usd,
    if(provider_cost_usd = 0, 0, drift_usd / provider_cost_usd) AS drift_pct
FROM gw
FULL OUTER JOIN pv
    ON  gw.tenant_id      = pv.tenant_id
    AND gw.day            = pv.day
    AND gw.model          = pv.model
    AND gw.virtual_key_id = pv.virtual_key_id
-- join_use_nulls=1 makes the coalesce above pick the present side on outer rows
-- (ClickHouse otherwise fills unmatched JOIN columns with type defaults).
SETTINGS join_use_nulls = 1;

-- ============================================================
-- 3. Flagged-drift convenience view now carries the key dimension.
-- ============================================================
CREATE OR REPLACE VIEW agentledger.v_flagged_drift AS
SELECT
    tenant_id, day, model, virtual_key_id,
    gateway_cost_usd, provider_cost_usd, drift_usd, drift_pct, threshold_pct
FROM agentledger.cost_adjustments FINAL
WHERE flagged = 1;
