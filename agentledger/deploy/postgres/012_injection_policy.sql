-- AgentLedger Postgres migration 012 — per-virtual-key prompt-injection policy
--
-- Phase 5/6: deterministic inline prompt-injection shield (ADR-048). Mirrors the
-- DLP policy wiring: injection_policy holds per-tenant policy rows; virtual_keys
-- optionally references one via injection_policy_id.
--
-- Forward-only; never edit an applied migration.

BEGIN;

CREATE TABLE injection_policy (
    id          TEXT PRIMARY KEY,
    tenant_id   UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    name        TEXT NOT NULL,
    classes     TEXT[] NOT NULL DEFAULT '{}',   -- empty = all classes
    action      TEXT NOT NULL DEFAULT 'block'   -- block | redact | flag | log
                CHECK (action IN ('block', 'redact', 'flag', 'log')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE virtual_keys
    ADD COLUMN IF NOT EXISTS injection_policy_id TEXT
    REFERENCES injection_policy(id);

-- Same tenant-isolation pattern as the other tenant-scoped tables (002_rls).
ALTER TABLE injection_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE injection_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON injection_policy
    USING (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON injection_policy TO agentledger_api;

COMMIT;
