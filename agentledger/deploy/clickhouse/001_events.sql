-- AgentLedger ClickHouse schema (analytics plane)
--
-- Design follows production-proven patterns for LLM event analytics:
--   * MergeTree partitioned by month, ordered by (tenant_id, ts) so every
--     dashboard query prunes to one tenant + time range before scanning.
--   * LowCardinality for provider/model/status dimensions.
--   * Incremental materialized views pre-aggregate the hot dashboard
--     queries (spend by day/model/team) at insert time.
--   * Raw events are kept (TTL-tiered) for drill-down and recalculation
--     when the price book changes.

CREATE DATABASE IF NOT EXISTS agentledger;

-- ============================================================
-- Raw LLM call events (one row per gateway/SDK/connector call)
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.llm_calls
(
    call_id            String,
    ts                 DateTime64(3) CODEC(Delta, ZSTD),

    -- attribution
    tenant_id          LowCardinality(String),
    team_id            LowCardinality(String),
    user_id            String,
    app_id             LowCardinality(String),
    environment        LowCardinality(String),
    virtual_key_id     String,

    -- agent context
    agent_id           String DEFAULT '',
    run_id             String DEFAULT '',
    step_id            String DEFAULT '',

    -- gen_ai.* aligned
    provider           LowCardinality(String),
    request_model      LowCardinality(String),
    response_model     LowCardinality(String),
    operation_name     LowCardinality(String),

    -- usage & cost
    input_tokens       UInt32,
    output_tokens      UInt32,
    cache_read_tokens  UInt32,
    cache_write_tokens UInt32,
    cost_usd           Float64,

    -- performance & status
    latency_ms         UInt32,
    status_code        UInt16,
    status             LowCardinality(String),   -- ok|upstream_error|blocked_*

    -- risk (categorical only; no raw content, ever)
    prompt_hash        String,
    dlp_action         LowCardinality(String),
    risk_severity      LowCardinality(String),
    dlp_findings       String DEFAULT '[]',      -- JSON array of findings
    streamed           UInt8,

    -- ingestion provenance for cross-source dedup (gateway/sdk/provider_export)
    source             LowCardinality(String) DEFAULT 'gateway'
)
ENGINE = ReplacingMergeTree            -- dedup on (tenant, call_id) across sources
PARTITION BY toYYYYMM(ts)
ORDER BY (tenant_id, ts, call_id)
TTL toDateTime(ts) + INTERVAL 13 MONTH TO VOLUME 'cold'
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- =====================================================
-- Hot dashboard aggregates (incremental MVs)
-- =====================================================

-- Daily spend by tenant/team/app/model — powers the exec dashboard.
CREATE TABLE IF NOT EXISTS agentledger.spend_daily
(
    day            Date,
    tenant_id      LowCardinality(String),
    team_id        LowCardinality(String),
    app_id         LowCardinality(String),
    provider       LowCardinality(String),
    model          LowCardinality(String),
    calls          UInt64,
    input_tokens   UInt64,
    output_tokens  UInt64,
    cached_tokens  UInt64,
    cost_usd       Float64,
    blocked_calls  UInt64,
    error_calls    UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, day, team_id, app_id, provider, model);

CREATE MATERIALIZED VIEW IF NOT EXISTS agentledger.mv_spend_daily
TO agentledger.spend_daily AS
SELECT
    toDate(ts)                                   AS day,
    tenant_id, team_id, app_id, provider,
    if(response_model != '', response_model, request_model) AS model,
    count()                                      AS calls,
    sum(input_tokens)                            AS input_tokens,
    sum(output_tokens)                           AS output_tokens,
    sum(cache_read_tokens)                       AS cached_tokens,
    sum(cost_usd)                                AS cost_usd,
    countIf(status LIKE 'blocked%')              AS blocked_calls,
    countIf(status = 'upstream_error')           AS error_calls
FROM agentledger.llm_calls
GROUP BY day, tenant_id, team_id, app_id, provider, model;

-- Hourly spend by virtual key — powers budget burn-down and anomaly
-- detection (runaway agent loops show up here within minutes).
CREATE TABLE IF NOT EXISTS agentledger.spend_hourly_by_key
(
    hour           DateTime,
    tenant_id      LowCardinality(String),
    virtual_key_id String,
    agent_id       String,
    calls          UInt64,
    cost_usd       Float64,
    total_tokens   UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, hour, virtual_key_id, agent_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS agentledger.mv_spend_hourly_by_key
TO agentledger.spend_hourly_by_key AS
SELECT
    toStartOfHour(ts) AS hour,
    tenant_id, virtual_key_id, agent_id,
    count()           AS calls,
    sum(cost_usd)     AS cost_usd,
    sum(input_tokens + output_tokens) AS total_tokens
FROM agentledger.llm_calls
GROUP BY hour, tenant_id, virtual_key_id, agent_id;

-- Daily risk rollup — powers the CISO dashboard and "risk-adjusted ROI"
-- joins (spend + risk events per team in one query).
CREATE TABLE IF NOT EXISTS agentledger.risk_daily
(
    day           Date,
    tenant_id     LowCardinality(String),
    team_id       LowCardinality(String),
    user_id       String,
    dlp_action    LowCardinality(String),
    risk_severity LowCardinality(String),
    events        UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, day, team_id, user_id, dlp_action, risk_severity);

CREATE MATERIALIZED VIEW IF NOT EXISTS agentledger.mv_risk_daily
TO agentledger.risk_daily AS
SELECT
    toDate(ts) AS day,
    tenant_id, team_id, user_id, dlp_action, risk_severity,
    count() AS events
FROM agentledger.llm_calls
WHERE dlp_action != 'allow'
GROUP BY day, tenant_id, team_id, user_id, dlp_action, risk_severity;

-- ============================================================
-- Agent runs (from SDK traces) — unit-economics denominator
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.agent_runs
(
    run_id        String,
    tenant_id     LowCardinality(String),
    agent_id      String,
    app_id        LowCardinality(String),
    user_id       String,
    started_at    DateTime64(3),
    ended_at      DateTime64(3),
    status        LowCardinality(String),  -- completed|failed|cancelled|timeout
    objective     String DEFAULT '',
    outcome_id    String DEFAULT '',       -- link to business outcome
    total_cost_usd Float64,
    total_tokens  UInt64,
    llm_calls     UInt32,
    tool_calls    UInt32,
    risk_events   UInt32
)
ENGINE = ReplacingMergeTree(ended_at)
PARTITION BY toYYYYMM(started_at)
ORDER BY (tenant_id, started_at, run_id);

-- ============================================================
-- Business outcomes (from ROI connectors / outcome API)
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.outcomes
(
    outcome_id             String,
    tenant_id              LowCardinality(String),
    ts                     DateTime64(3),
    source_system          LowCardinality(String),  -- jira|github|zendesk|manual|api
    outcome_type           LowCardinality(String),  -- pr_merged|ticket_resolved|invoice_processed|...
    team_id                LowCardinality(String),
    user_id                String,
    run_id                 String DEFAULT '',
    business_value_usd     Float64 DEFAULT 0,
    quality_score          Float32 DEFAULT 0,
    attribution_confidence Float32 DEFAULT 0,       -- 0..1, per PRD §6.3
    completion_status      LowCardinality(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (tenant_id, ts, outcome_id);

-- Cost-per-outcome view: the product's headline metric.
CREATE VIEW IF NOT EXISTS agentledger.v_unit_economics AS
SELECT
    o.tenant_id,
    toStartOfMonth(o.ts)      AS month,
    o.outcome_type,
    o.team_id,
    count()                   AS outcomes,
    sum(r.total_cost_usd)     AS ai_cost_usd,
    sum(o.business_value_usd) AS business_value_usd,
    ai_cost_usd / nullIf(outcomes, 0)            AS cost_per_outcome,
    business_value_usd - ai_cost_usd             AS net_value_usd,
    avg(o.attribution_confidence)                AS avg_confidence
FROM agentledger.outcomes o
LEFT JOIN agentledger.agent_runs r
    ON r.tenant_id = o.tenant_id AND r.run_id = o.run_id
GROUP BY o.tenant_id, month, o.outcome_type, o.team_id;
