-- BadgerIQ Postgres migration 006 — agent tool/MCP governance allowlist
--
-- Phase 5 (Agent-Native Risk Engine): a per-agent, deny-by-default allowlist of
-- the tools / MCP servers an agent may use. The risk-engine worker flags any
-- observed tool call (ClickHouse agent_tool_calls) that is NOT in the agent's
-- allowlist as a governed risk event, which feeds agent_risk → risk-adjusted ROI.
-- This table is the control-plane source of truth; the API projects it into the
-- ClickHouse agent_tool_allow table the worker reads (mirrors roi_rates).
--
-- Forward-only; never edit an applied migration.

BEGIN;

CREATE TABLE agent_tool_allowlist (
    allow_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    agent_id    UUID NOT NULL REFERENCES agents ON DELETE CASCADE,
    tool_name   TEXT NOT NULL,
    mcp_server  TEXT,                      -- optional MCP server the tool belongs to
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, agent_id, tool_name)
);

-- Same tenant-isolation pattern as the other tenant-scoped tables (002_rls).
ALTER TABLE agent_tool_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_allowlist FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_tool_allowlist
    USING (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_tool_allowlist TO agentledger_api;

COMMIT;
