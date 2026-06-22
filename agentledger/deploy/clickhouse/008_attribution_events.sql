-- AgentLedger ClickHouse migration 008 — attribution decision log + daily rollup
--
-- Phase 3 deepening (docs/ATTRIBUTION_ENGINE_BUILD.md §3; ADR-040). The attribution
-- engine's relational source of truth is Postgres (attribution_edges et al.); this
-- analytical, append-only log captures each attribution DECISION for trend analysis
-- and calibration backtesting, and feeds an MV for "attributed value/cost by agent
-- by day".
--
-- This does NOT replace the §8 stable contract: the worker still stamps
-- outcomes.attribution_confidence (read by v_roi / v_outcome_graph). These events
-- are additive analytics, never read by the ROI engine.
--
-- Append-only MergeTree (one row per decision, no dedup — re-scores are new rows
-- with a later ts and model_version, so calibration backtests can replay history).
-- tenant_id leads ORDER BY (CLAUDE.md rule 3). No raw content — references and
-- categorical/financial attributes only (rule 2; §7 — evidence not payloads).
--
-- Forward-only; never edit an applied migration.

-- ============================================================
-- attribution_events — one row per attribution decision
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.attribution_events
(
    ts                    DateTime64(3),
    tenant_id             LowCardinality(String),
    outcome_id            String,
    outcome_type          LowCardinality(String),
    run_id                String,
    agent_id              String,
    coalition_id          String DEFAULT '',
    attribution_method    LowCardinality(String),  -- deterministic | probabilistic | shapley
    confidence_raw        Float64,
    confidence_calibrated Float64,
    counterfactual_delta  Float64 DEFAULT 0,
    value_attributed      Float64 DEFAULT 0,
    cost_attributed       Float64 DEFAULT 0,
    model_version         LowCardinality(String),
    engine_version        LowCardinality(String) DEFAULT 'v2'  -- v1 (legacy heuristic) | v2 (this engine)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (tenant_id, ts, outcome_id);

-- ============================================================
-- Attributed value/cost by agent by day (incremental MV)
-- Powers the CFO/cost-per-outcome trend and the calibration backtest aggregates.
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.attribution_by_agent_daily
(
    day                Date,
    tenant_id          LowCardinality(String),
    agent_id           String,
    attribution_method LowCardinality(String),
    attributions       UInt64,
    value_attributed   Float64,
    cost_attributed    Float64,
    -- sum of calibrated confidence; avg = sum_confidence / attributions
    sum_confidence     Float64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, day, agent_id, attribution_method);

CREATE MATERIALIZED VIEW IF NOT EXISTS agentledger.mv_attribution_by_agent_daily
TO agentledger.attribution_by_agent_daily AS
SELECT
    toDate(ts)             AS day,
    tenant_id,
    agent_id,
    attribution_method,
    count()                AS attributions,
    sum(value_attributed)  AS value_attributed,
    sum(cost_attributed)   AS cost_attributed,
    sum(confidence_calibrated) AS sum_confidence
FROM agentledger.attribution_events
GROUP BY day, tenant_id, agent_id, attribution_method;
