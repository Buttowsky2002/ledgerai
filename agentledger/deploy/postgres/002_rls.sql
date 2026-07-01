-- BadgerIQ Postgres migration 002 — tenant isolation via row-level security
--
-- Enables RLS on every tenant-scoped table so a connection can only see/modify
-- rows for the tenant bound to `app.tenant_id` for the current transaction. The
-- control-plane API (services/api) sets that GUC per request with
-- set_config('app.tenant_id', <uuid>, true) inside an interactive transaction
-- (SET LOCAL semantics — never leaks across pooled connections). See ADR-010.
--
-- Fail-closed: with no tenant bound, app_current_tenant() is NULL and every
-- policy predicate is false → zero rows, no error.
--
-- Forward-only; never edit an applied migration.

BEGIN;

-- ============================================================
-- Current-request tenant accessor (NULL when unset → fail closed)
-- ============================================================
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
    LANGUAGE sql STABLE
    -- nullif so an empty binding ('') becomes NULL rather than erroring on ''::uuid
    AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- ============================================================
-- Least-privilege API role (security rules 6 + 7)
-- ============================================================
-- NOLOGIN here: a forward-only migration runs in production too, so it must not
-- embed a password (rule 1). The login + password are granted out-of-band — by a
-- secret manager in prod, and by deploy/postgres-dev/ for the local stack.
-- No SUPERUSER and no BYPASSRLS: this role is always subject to the policies below.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentledger_api') THEN
        CREATE ROLE agentledger_api NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agentledger_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agentledger_api; -- audit_log BIGSERIAL
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentledger_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO agentledger_api;

-- price_book is global reference data (no tenant_id): API role reads only.
REVOKE INSERT, UPDATE, DELETE ON price_book FROM agentledger_api;
GRANT SELECT ON price_book TO agentledger_api;

-- ============================================================
-- Uniform tenant isolation on tables keyed by tenant_id
-- ============================================================
-- FORCE so the table owner (and the dev bootstrap superuser, when it is the
-- connecting role) is also subject — only true SUPERUSER / BYPASSRLS escapes,
-- which agentledger_api is not. The API must connect as agentledger_api.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'tenants', 'teams', 'identities', 'apps', 'agents', 'virtual_keys',
        'policies', 'allocation_rules', 'budgets', 'connectors', 'audit_log'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = app_current_tenant()) '
            'WITH CHECK (tenant_id = app_current_tenant())', t);
    END LOOP;
END
$$;

-- ============================================================
-- roi_templates: tenant rows + shared built-in packs (tenant_id IS NULL)
-- ============================================================
-- Readable: own-tenant rows AND built-in packs. Writable: own-tenant only
-- (a tenant can never mutate a built-in pack).
ALTER TABLE roi_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE roi_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON roi_templates FOR SELECT
    USING (tenant_id = app_current_tenant() OR tenant_id IS NULL);
CREATE POLICY tenant_insert ON roi_templates FOR INSERT
    WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_update ON roi_templates FOR UPDATE
    USING (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_delete ON roi_templates FOR DELETE
    USING (tenant_id = app_current_tenant());

COMMIT;
