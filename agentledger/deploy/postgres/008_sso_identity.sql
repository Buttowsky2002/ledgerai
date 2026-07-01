-- BadgerIQ Postgres migration 008 — enterprise SSO (per-tenant OIDC) + JIT
--
-- Phase 6 (P6-D1). Today auth is a single GLOBAL Google/Microsoft OIDC app and an
-- unknown email is rejected (ADR-011, no auto-provisioning). Enterprises bring
-- their own IdP (Okta/Entra/...) and expect their workforce to sign in through it
-- with identities provisioned on first login. This migration adds:
--
--   1. tenant_idp_config — a per-tenant OIDC IdP (issuer/client/secret-ref + the
--      email domains that route to it). Tenant-scoped, RLS like every other table.
--   2. identities.external_id / active — the IdP/SCIM subject and a soft-deactivate
--      flag (deactivated identities are refused at login). external_id + active are
--      also consumed by SCIM provisioning (P6-D2).
--   3. Three SECURITY DEFINER lookups, the only sanctioned RLS bypass (mirrors
--      auth_lookup_identity in 003): login runs before any tenant is bound, so a
--      plain SELECT would return zero rows under RLS.
--
-- Secrets: client_secret_ref holds a *reference* (env-var name / KMS-vault key),
-- never the secret itself (rules 1 + 9) — same convention as connectors.secret_ref
-- and the gateway's api_key_env.
--
-- Forward-only; never edit an applied migration.

BEGIN;

-- ============================================================
-- identities: external subject id + soft-deactivate
-- ============================================================
ALTER TABLE identities
    ADD COLUMN IF NOT EXISTS external_id TEXT,
    ADD COLUMN IF NOT EXISTS active      BOOLEAN NOT NULL DEFAULT true;

-- One external id per identity within a tenant (SCIM/IdP subject is unique there).
CREATE UNIQUE INDEX IF NOT EXISTS identities_tenant_external_id_uniq
    ON identities (tenant_id, external_id)
    WHERE external_id IS NOT NULL;

-- ============================================================
-- Per-tenant OIDC IdP configuration
-- ============================================================
CREATE TABLE tenant_idp_config (
    idp_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    protocol          TEXT NOT NULL DEFAULT 'oidc',     -- future-proofs SAML; only 'oidc' today
    issuer            TEXT NOT NULL,                    -- OIDC discovery issuer URL
    client_id         TEXT NOT NULL,
    client_secret_ref TEXT NOT NULL,                    -- env-var name / KMS-vault key — NEVER the secret (rules 1, 9)
    email_domains     TEXT[] NOT NULL DEFAULT '{}',     -- domains that route to this tenant at login
    jit_enabled       BOOLEAN NOT NULL DEFAULT true,    -- auto-provision identities on first login
    default_api_role  TEXT NOT NULL DEFAULT 'viewer'
        CHECK (default_api_role IN ('viewer', 'analyst', 'admin')),
    enabled           BOOLEAN NOT NULL DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Same tenant-isolation pattern as 002_rls.sql.
ALTER TABLE tenant_idp_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_idp_config FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_idp_config
    USING (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_idp_config TO agentledger_api;

-- ============================================================
-- SECURITY DEFINER auth lookups (RLS-exempt, auth-infrastructure only)
-- ============================================================

-- Resolve a login email's domain to the tenant IdP that should handle it. Returns
-- at most one enabled config whose email_domains contains the (lowercased) domain.
CREATE OR REPLACE FUNCTION idp_lookup_by_domain(p_domain text)
    RETURNS TABLE (
        tenant_id         uuid,
        idp_id            uuid,
        issuer            text,
        client_id         text,
        client_secret_ref text,
        jit_enabled       boolean,
        default_api_role  text
    )
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$
        SELECT tenant_id, idp_id, issuer, client_id, client_secret_ref,
               jit_enabled, default_api_role
        FROM tenant_idp_config
        WHERE enabled = true
          AND lower(p_domain) = ANY (email_domains)
        LIMIT 1
    $$;

-- Tenant-scoped identity lookup for the SSO callback (the same email may exist in
-- multiple tenants once each has its own IdP, so the global auth_lookup_identity
-- is not enough). Returns the active flag so the caller can reject deactivated
-- users distinctly from absent ones (JIT only provisions the truly absent).
CREATE OR REPLACE FUNCTION auth_lookup_identity_in_tenant(p_tenant uuid, p_email text)
    RETURNS TABLE (user_id uuid, api_role text, active boolean)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$
        SELECT user_id, api_role, active
        FROM identities
        WHERE tenant_id = p_tenant AND email = p_email
        LIMIT 1
    $$;

-- JIT-provision an SSO identity. INSERT ... ON CONFLICT DO NOTHING so a race or a
-- pre-existing row never errors; RETURNING yields the new row, or no rows if it
-- already existed (the caller then falls back to the lookup above).
CREATE OR REPLACE FUNCTION auth_provision_identity(
        p_tenant uuid, p_email text, p_external_id text, p_source text, p_api_role text)
    RETURNS TABLE (user_id uuid, api_role text)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
    AS $$
        INSERT INTO identities (tenant_id, email, external_id, source, api_role, active)
        VALUES (p_tenant, p_email, p_external_id, p_source, p_api_role, true)
        ON CONFLICT (tenant_id, email) DO NOTHING
        RETURNING user_id, api_role
    $$;

-- Global-provider login (auth_lookup_identity, migration 003) must also refuse
-- deactivated identities now that `active` exists. Same signature → CREATE OR
-- REPLACE is in-place (no DROP). Inactive identities fall to zero rows → 401.
CREATE OR REPLACE FUNCTION auth_lookup_identity(p_email text)
    RETURNS TABLE (user_id uuid, tenant_id uuid, api_role text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$
        SELECT user_id, tenant_id, api_role
        FROM identities
        WHERE email = p_email AND active = true
        LIMIT 1
    $$;

REVOKE EXECUTE ON FUNCTION idp_lookup_by_domain(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION auth_lookup_identity_in_tenant(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION auth_provision_identity(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION idp_lookup_by_domain(text) TO agentledger_api;
GRANT EXECUTE ON FUNCTION auth_lookup_identity_in_tenant(uuid, text) TO agentledger_api;
GRANT EXECUTE ON FUNCTION auth_provision_identity(uuid, text, text, text, text) TO agentledger_api;

COMMIT;
