-- BadgerIQ Postgres migration 003 — API authz role + SSO identity lookup
--
-- Phase 3 task 2 adds OIDC login + RBAC. Two pieces live in the DB:
--
--  1. identities.api_role — the API authorization tier (viewer|analyst|admin),
--     a DIFFERENT axis from identities.role (member|admin|finance|security, an
--     identity-graph/ownership concept that is left untouched).
--
--  2. auth_lookup_identity() — resolves an SSO email to its identity BEFORE any
--     tenant is known. Normal queries can't: RLS (002) needs app.tenant_id, which
--     isn't set during login, so a plain SELECT returns zero rows. This SECURITY
--     DEFINER function runs as its owner (RLS-exempt) to perform exactly that one
--     lookup, by exact email, returning only the minimal auth fields. It is the
--     ONLY sanctioned RLS bypass and is auth-infrastructure-only.
--
-- Forward-only; never edit an applied migration.

BEGIN;

-- ============================================================
-- API authorization role
-- ============================================================
ALTER TABLE identities
    ADD COLUMN IF NOT EXISTS api_role TEXT NOT NULL DEFAULT 'viewer'
    CHECK (api_role IN ('viewer', 'analyst', 'admin'));

-- ============================================================
-- SSO email → identity (controlled RLS bypass, auth only)
-- ============================================================
CREATE OR REPLACE FUNCTION auth_lookup_identity(p_email text)
    RETURNS TABLE (user_id uuid, tenant_id uuid, api_role text)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $$
        SELECT user_id, tenant_id, api_role
        FROM identities
        WHERE email = p_email
        -- SSO assumes one identity per email (see ADR-011). LIMIT keeps the
        -- contract single-row even if that assumption is ever violated.
        LIMIT 1
    $$;

-- Default EXECUTE is granted to PUBLIC for new functions — lock it down so only
-- the API role can call the privileged lookup.
REVOKE EXECUTE ON FUNCTION auth_lookup_identity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_identity(text) TO agentledger_api;

COMMIT;
