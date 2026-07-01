-- BadgerIQ Postgres migration 007 — non-human identity (NHI) credentials
--
-- Phase 6 (deferred from P5): governance for the short-lived, scoped credentials
-- an agent (a non-human identity) uses. Credentials are issued in a "pending"
-- state, approved into "active" with an expiry, and revoked manually or when an
-- agent goes dormant. The secret is stored only as a SHA-256 hash (CLAUDE.md
-- rule 6 — plaintext shown once at issuance); "expired" is derived from
-- expires_at at read time. The blast-radius view joins active credentials with
-- the tool allowlist (migration 006) to show each agent's exposure.
--
-- Forward-only; never edit an applied migration.

BEGIN;

CREATE TABLE agent_credentials (
    credential_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    agent_id      UUID NOT NULL REFERENCES agents ON DELETE CASCADE,
    name          TEXT NOT NULL,                       -- human label for the credential
    token_hash    TEXT NOT NULL,                       -- SHA-256 hex; plaintext shown once at issuance
    scopes        TEXT[] NOT NULL DEFAULT '{}',        -- least-privilege scopes (e.g. tool names / resources)
    status        TEXT NOT NULL DEFAULT 'pending',     -- pending | active | revoked
    expires_at    TIMESTAMPTZ,                         -- short-lived; set on approval
    approved_by   TEXT,                                -- identity that approved (from auth context)
    approved_at   TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ,
    revoked_reason TEXT,
    last_used_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, token_hash)
);

CREATE INDEX agent_credentials_agent_idx ON agent_credentials (tenant_id, agent_id);

-- Same tenant-isolation pattern as the other tenant-scoped tables (002_rls).
ALTER TABLE agent_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_credentials
    USING (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_credentials TO agentledger_api;

COMMIT;
