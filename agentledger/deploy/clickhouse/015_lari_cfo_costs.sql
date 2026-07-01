-- BadgerIQ ClickHouse migration 015 — LARI CFO supplemental costs
--
-- coding_agent_daily: Cursor / Claude Code / Copilot usage rolled up for LARI
-- fully-loaded cost (coding_agent_cost_allocated). Populated by import/connector
-- paths; empty until data is ingested.
--
-- Forward-only; never edit an applied migration.

CREATE TABLE IF NOT EXISTS agentledger.coding_agent_daily
(
    tenant_id   LowCardinality(String),
    day         Date,
    provider    LowCardinality(String),
    user_id     String DEFAULT '',
    team_id     String DEFAULT '',
    agent_id    String DEFAULT '',
    cost_usd    Float64 DEFAULT 0,
    sessions    UInt32 DEFAULT 0,
    requests    UInt32 DEFAULT 0
)
ENGINE = SummingMergeTree()
ORDER BY (tenant_id, day, provider, user_id, team_id, agent_id);
