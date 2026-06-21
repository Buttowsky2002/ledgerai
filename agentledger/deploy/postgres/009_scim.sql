-- AgentLedger Postgres migration 009 — SCIM 2.0 provisioning (P6-D2)
--
-- Phase 6 (P6-D2, pairs with ADR-033/SSO). Lets a tenant's IdP (Okta/Entra/...)
-- provision and DEPROVISION users/groups via SCIM 2.0 (RFC 7643/7644):
--
--   1. scim_tokens — a per-tenant bearer token the IdP authenticates with. Stored
--      only as a SHA-256 hash (rule 6, plaintext shown once at issuance), same as
--      agent_credentials (007) and virtual_keys.
--   2. teams.external_id — lets SCIM Groups round-trip to teams by IdP id.
--      (identities.external_id / active arrived in 008 and carry the SCIM User
--      lifecycle: external_id = SCIM id, active = SCIM active.)
--   3. scim_token_resolve() — SECURITY DEFINER (the sanctioned RLS bypass, like
--      auth_lookup_identity): the SCIM auth guard must resolve a bearer token to
--      its tenant BEFORE any tenant is bound. It also stamps last_used_at.
--
-- Forward-only; never edit an applied migration.

BEGIN;

-- ============================================================
-- Per-tenant SCIM bearer token
-- ============================================================
CREATE TABLE scim_tokens (
    token_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    name         TEXT NOT NULL,                  -- human label (e.g. "Okta prod")
    token_hash   TEXT NOT NULL,                  -- SHA-256 hex; plaintext shown once at issuance
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    UNIQUE (tenant_id, token_hash)
);

-- Resolver is by hash alone (no tenant context yet), so the hash must be globally
-- unique, not just per-tenant.
CREATE UNIQUE INDEX scim_tokens_hash_uniq ON scim_tokens (token_hash);

ALTER TABLE scim_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scim_tokens
    USING (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_tokens TO agentledger_api;

-- ============================================================
-- teams: external (SCIM Group) id
-- ============================================================
ALTER TABLE teams ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS teams_tenant_external_id_uniq
    ON teams (tenant_id, external_id)
    WHERE external_id IS NOT NULL;

-- ============================================================
-- SCIM bearer resolution (RLS-exempt, SCIM-auth only)
-- ============================================================
-- Resolve a presented SCIM token (by SHA-256 hash) to its tenant and stamp
-- last_used_at. VOLATILE because it writes; SECURITY DEFINER because the guard
-- runs before any app.tenant_id is set. Revoked tokens resolve to zero rows.
CREATE OR REPLACE FUNCTION scim_token_resolve(p_hash text)
    RETURNS TABLE (tenant_id uuid, token_id uuid)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
    AS $$
        UPDATE scim_tokens
        SET last_used_at = now()
        WHERE token_hash = p_hash AND revoked_at IS NULL
        RETURNING tenant_id, token_id
    $$;

REVOKE EXECUTE ON FUNCTION scim_token_resolve(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scim_token_resolve(text) TO agentledger_api;

COMMIT;
