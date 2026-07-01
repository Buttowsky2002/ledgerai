-- BadgerIQ ClickHouse migration 002 — provider-billed costs
--
-- Connectors (Phase 2) import what each provider actually billed, at the
-- granularity the provider reports (typically per day / model / line item).
-- The reconciliation worker diffs this against gateway-observed cost
-- (llm_calls where source='gateway') to surface cost drift.
--
-- Forward-only; never edit an applied migration.

-- ============================================================
-- Provider-billed costs (one row per provider billing line)
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.provider_costs
(
    tenant_id      LowCardinality(String),
    day            Date,
    provider       LowCardinality(String),          -- openai|anthropic|bedrock|vertex
    model          LowCardinality(String),
    line_item      String DEFAULT '',               -- provider SKU / usage_type, if any
    virtual_key_id String DEFAULT '',               -- provider project/key, when exposed

    input_tokens   UInt64 DEFAULT 0,
    output_tokens  UInt64 DEFAULT 0,
    cost_usd       Float64,
    currency       LowCardinality(String) DEFAULT 'USD',

    source         LowCardinality(String),          -- connector kind: openai_usage|anthropic_usage|bedrock|vertex
    imported_at    DateTime64(3)                     -- ReplacingMergeTree version: latest import wins
)
ENGINE = ReplacingMergeTree(imported_at)
PARTITION BY toYYYYMM(day)
-- Ordering key == the natural identity of a billing line, so re-importing a day
-- (crash replay, cursor rewind) collapses to a single row — idempotent ingest.
ORDER BY (tenant_id, day, provider, model, source, line_item, virtual_key_id);

-- ============================================================
-- Reconciliation: gateway-observed vs provider-billed, per day/model
-- ============================================================
-- Drift = provider_billed - gateway_observed. The worker (Phase 2 task 5)
-- books adjustment events and flags |drift| / provider_billed > 2%.
CREATE VIEW IF NOT EXISTS agentledger.v_cost_reconciliation AS
WITH
    gw AS
    (
        SELECT
            tenant_id,
            toDate(ts)                                          AS day,
            if(response_model != '', response_model, request_model) AS model,
            sum(cost_usd)                                       AS gateway_cost_usd,
            count()                                             AS gateway_calls
        FROM agentledger.llm_calls
        WHERE source = 'gateway' AND status = 'ok'
        GROUP BY tenant_id, day, model
    ),
    pv AS
    (
        SELECT
            tenant_id,
            day,
            model,
            sum(cost_usd) AS provider_cost_usd
        FROM agentledger.provider_costs
        FINAL
        GROUP BY tenant_id, day, model
    )
SELECT
    coalesce(gw.tenant_id, pv.tenant_id)              AS tenant_id,
    coalesce(gw.day, pv.day)                          AS day,
    coalesce(gw.model, pv.model)                      AS model,
    coalesce(gw.gateway_cost_usd, 0)                  AS gateway_cost_usd,
    coalesce(pv.provider_cost_usd, 0)                 AS provider_cost_usd,
    provider_cost_usd - gateway_cost_usd              AS drift_usd,
    if(provider_cost_usd = 0, 0, drift_usd / provider_cost_usd) AS drift_pct
FROM gw
FULL OUTER JOIN pv
    ON gw.tenant_id = pv.tenant_id AND gw.day = pv.day AND gw.model = pv.model
-- ClickHouse fills unmatched JOIN columns with defaults, not NULL, unless told;
-- join_use_nulls=1 makes coalesce above pick the present side on outer rows.
SETTINGS join_use_nulls = 1;
