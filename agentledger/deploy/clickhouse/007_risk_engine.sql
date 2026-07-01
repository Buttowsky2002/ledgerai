-- BadgerIQ ClickHouse migration 007 — agent-native risk engine
--
-- Phase 5: observe tool/MCP usage per agent, compare against the deny-by-default
-- allowlist, and raise governed risk events that roll up into agent_risk (the
-- seam P4 built into v_roi → risk-adjusted ROI).
--
--   agent_tool_calls (observed)  ┐
--                                ├─▶ [risk-engine worker] ─▶ risk_events
--   agent_tool_allow (allowlist) ┘                        └▶ agent_risk
--
-- Forward-only; never edit an applied migration.

-- ============================================================
-- Observed tool/MCP invocations (from SDK / OTel tool spans / connectors).
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.agent_tool_calls
(
    tenant_id    LowCardinality(String),
    agent_id     String,
    run_id       String DEFAULT '',
    tool_call_id String,                       -- stable id → idempotent ingest
    tool_name    LowCardinality(String),
    mcp_server   LowCardinality(String) DEFAULT '',
    ts           DateTime64(3)
)
ENGINE = ReplacingMergeTree(ts)
PARTITION BY toYYYYMM(ts)
ORDER BY (tenant_id, agent_id, tool_call_id);

-- ============================================================
-- Allowlist projection (CH mirror of Postgres agent_tool_allowlist; the API
-- upserts on CRUD). allowed=0 is a tombstone so a removed entry stops allowing.
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.agent_tool_allow
(
    tenant_id  LowCardinality(String),
    agent_id   String,
    tool_name  LowCardinality(String),
    allowed    UInt8 DEFAULT 1,
    updated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, agent_id, tool_name);

-- ============================================================
-- Governed risk events (one logical event per agent + category + detail).
-- ============================================================
CREATE TABLE IF NOT EXISTS agentledger.risk_events
(
    event_id    String,                        -- deterministic → idempotent
    tenant_id   LowCardinality(String),
    agent_id    String,
    run_id      String DEFAULT '',
    category    LowCardinality(String),        -- unauthorized_tool | tool_spike | ...
    severity    LowCardinality(String),        -- low | medium | high
    detail      String DEFAULT '',             -- e.g. the offending tool_name
    occurrences UInt32 DEFAULT 1,
    first_seen  DateTime64(3),
    detected_at DateTime64(3)                   -- ReplacingMergeTree version
)
ENGINE = ReplacingMergeTree(detected_at)
PARTITION BY toYYYYMM(first_seen)
ORDER BY (tenant_id, agent_id, event_id);

-- ============================================================
-- Governance views the worker reads (deny-by-default: a call is authorized only
-- if an allowlist row with allowed=1 exists for its (agent, tool)).
-- ============================================================
-- Per (tenant, agent, tool): the unauthorized tools and how often they were used.
CREATE OR REPLACE VIEW agentledger.v_unauthorized_tools AS
SELECT
    tc.tenant_id  AS tenant_id,
    tc.agent_id   AS agent_id,
    tc.tool_name  AS tool_name,
    min(tc.ts)    AS first_seen,
    count()       AS occurrences
FROM (SELECT tenant_id, agent_id, tool_name, tool_call_id, ts FROM agentledger.agent_tool_calls FINAL) AS tc
LEFT ANTI JOIN (SELECT tenant_id, agent_id, tool_name FROM agentledger.agent_tool_allow FINAL WHERE allowed = 1) AS al
    ON tc.tenant_id = al.tenant_id AND tc.agent_id = al.agent_id AND tc.tool_name = al.tool_name
GROUP BY tc.tenant_id, tc.agent_id, tc.tool_name;

-- Per (tenant, agent): exposure = unauthorized tool calls / total tool calls.
CREATE OR REPLACE VIEW agentledger.v_agent_tool_exposure AS
SELECT
    tc.tenant_id                       AS tenant_id,
    tc.agent_id                        AS agent_id,
    count()                            AS total_calls,
    countIf(isNull(al.allowed))        AS unauthorized_calls,
    countIf(isNull(al.allowed)) / count() AS exposure_pct
FROM (SELECT tenant_id, agent_id, tool_name, tool_call_id FROM agentledger.agent_tool_calls FINAL) AS tc
LEFT JOIN (SELECT tenant_id, agent_id, tool_name, allowed FROM agentledger.agent_tool_allow FINAL WHERE allowed = 1) AS al
    ON tc.tenant_id = al.tenant_id AND tc.agent_id = al.agent_id AND tc.tool_name = al.tool_name
GROUP BY tc.tenant_id, tc.agent_id
SETTINGS join_use_nulls = 1;
