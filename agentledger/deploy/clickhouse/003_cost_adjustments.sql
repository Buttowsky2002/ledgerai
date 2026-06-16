-- AgentLedger ClickHouse migration 003 — reconciliation adjustments
--
-- The reconciliation worker (services/workers/cmd/reconcile) reads
-- v_cost_reconciliation (gateway-observed vs provider-billed, per day/model),
-- books one adjustment row per (tenant, day, model), and flags rows whose
-- |drift_pct| exceeds the configured threshold (default 2%).
--
-- Forward-only; never edit an applied migration.

CREATE TABLE IF NOT EXISTS agentledger.cost_adjustments
(
    tenant_id         LowCardinality(String),
    day               Date,
    model             LowCardinality(String),

    gateway_cost_usd  Float64,
    provider_cost_usd Float64,
    drift_usd         Float64,            -- provider - gateway
    drift_pct         Float64,            -- drift_usd / provider_cost_usd

    flagged           UInt8,              -- 1 when |drift_pct| > threshold_pct
    threshold_pct     Float64,
    reconciled_at     DateTime64(3)       -- ReplacingMergeTree version
)
ENGINE = ReplacingMergeTree(reconciled_at)
PARTITION BY toYYYYMM(day)
-- One adjustment per (tenant, day, model): re-running reconciliation for a day
-- replaces the prior adjustment rather than duplicating it.
ORDER BY (tenant_id, day, model);

-- Convenience view: only the flagged (material) drift, newest reconciliation
-- per key (FINAL collapses superseded re-runs).
CREATE VIEW IF NOT EXISTS agentledger.v_flagged_drift AS
SELECT tenant_id, day, model, gateway_cost_usd, provider_cost_usd, drift_usd, drift_pct, threshold_pct
FROM agentledger.cost_adjustments FINAL
WHERE flagged = 1;
