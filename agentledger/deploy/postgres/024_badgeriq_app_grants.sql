-- BadgerIQ Postgres migration 024 — grant badgeriq_app the API role privileges
--
-- Cloud Run MVP connects as the Cloud SQL login `badgeriq_app` (see the
-- badgeriq-api service env). Migrations 002+ grant table access to the
-- `agentledger_api` NOLOGIN role. This migration makes `badgeriq_app` inherit
-- those grants so RLS-enforced CRUD works without connecting as superuser.
--
-- Local docker / CI: `badgeriq_app` is not created (pg-dev-init uses
-- agentledger_api via SET ROLE). Skip the GRANT with a NOTICE instead of
-- aborting initdb — otherwise postgres exits and e2e cannot start.
--
-- Forward-only; never edit an applied migration.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentledger_api') THEN
        RAISE EXCEPTION 'role agentledger_api does not exist - apply migration 002 first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'badgeriq_app') THEN
        RAISE NOTICE 'role badgeriq_app does not exist - skipping Cloud SQL login grant (expected in local docker/CI)';
    ELSE
        -- Inherit every grant agentledger_api already has (tables, sequences, functions).
        EXECUTE 'GRANT agentledger_api TO badgeriq_app';
    END IF;
END
$$;

COMMIT;
