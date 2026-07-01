-- BadgerIQ ClickHouse migration 012 — fixed / recurring AI overhead
--
-- Seat licenses, subscriptions, platform fees, and committed-use charges that are
-- NOT metered per token and NOT attributable to any agent or outcome. These rows
-- sit BESIDE the attribution graph, never inside it — v_roi and related views
-- remain metered-spend-only and are unchanged by this migration.
--
-- v_total_cost_of_ai is the ONLY junction where attributable metered spend and
-- un-attributable fixed overhead meet. Attribution-side views (005, 006, 008,
-- 010, 011) are not modified here.
--
-- Forward-only; never edit an applied migration.

-- ============================================================
-- Fixed / recurring AI costs (one row per tenant-period-vendor-type-line)
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.fixed_costs
(
    tenant_id     LowCardinality(String),
    period_month  Date,                       -- first day of the month the charge applies to
    vendor        LowCardinality(String),     -- openai|anthropic|other
    cost_type     LowCardinality(String),     -- seat_license|subscription|platform_fee|committed_use
    line_item     String DEFAULT '',          -- e.g. "ChatGPT Team", "Claude Team seat"
    seats         UInt32 DEFAULT 0,           -- 0 when not seat-based
    unit_cost_usd Float64 DEFAULT 0,          -- per-seat or per-unit, informational
    cost_usd      Float64,                    -- total charge for the period (the number that counts)
    currency      LowCardinality(String) DEFAULT 'USD',
    -- ALWAYS 0 for this table: documents the boundary vs attributable metered spend and
    -- lets union views filter without a magic literal. Fixed cost cannot attach to agents.
    attributable  UInt8 DEFAULT 0,
    source        LowCardinality(String),     -- manual|openai_billing|anthropic_billing
    note          String DEFAULT '',
    imported_at   DateTime64(3)               -- ReplacingMergeTree version: latest write wins
)
ENGINE = ReplacingMergeTree(imported_at)
PARTITION BY toYYYYMM(period_month)
-- Ordering key == natural identity so re-import / manual update collapses to one row.
ORDER BY (tenant_id, period_month, vendor, cost_type, line_item);

-- ============================================================
-- Monthly fixed-cost rollup (newest row per identity, then summed)
-- ============================================================
CREATE VIEW IF NOT EXISTS agentledger.v_fixed_cost_monthly AS
SELECT
    tenant_id,
    period_month,
    vendor,
    cost_type,
    sum(cost_usd)     AS cost_usd,
    sum(seats)        AS seats,
    max(imported_at)  AS last_imported_at
FROM agentledger.fixed_costs
FINAL
WHERE attributable = 0
GROUP BY tenant_id, period_month, vendor, cost_type;

-- ============================================================
-- Total cost of AI — attributable metered spend + un-attributable overhead
-- ============================================================
CREATE VIEW IF NOT EXISTS agentledger.v_total_cost_of_ai AS
WITH
    gw AS
    (
        SELECT
            tenant_id,
            toStartOfMonth(toDate(ts)) AS month,
            sum(cost_usd)              AS attributable_cost_usd
        FROM agentledger.llm_calls
        WHERE source = 'gateway' AND status = 'ok'
        GROUP BY tenant_id, month
    ),
    fx AS
    (
        SELECT
            tenant_id,
            toStartOfMonth(period_month) AS month,
            sum(cost_usd)                AS fixed_cost_usd
        FROM agentledger.fixed_costs
        FINAL
        WHERE attributable = 0
        GROUP BY tenant_id, month
    )
SELECT
    coalesce(gw.tenant_id, fx.tenant_id) AS tenant_id,
    coalesce(gw.month, fx.month)          AS month,
    coalesce(gw.attributable_cost_usd, 0) AS attributable_cost_usd,
    coalesce(fx.fixed_cost_usd, 0)        AS fixed_cost_usd,
    coalesce(gw.attributable_cost_usd, 0) + coalesce(fx.fixed_cost_usd, 0) AS total_cost_of_ai_usd,
    coalesce(fx.fixed_cost_usd, 0)
        / nullIf(coalesce(gw.attributable_cost_usd, 0) + coalesce(fx.fixed_cost_usd, 0), 0) AS fixed_cost_pct
FROM gw
FULL OUTER JOIN fx
    ON gw.tenant_id = fx.tenant_id AND gw.month = fx.month
SETTINGS join_use_nulls = 1;
