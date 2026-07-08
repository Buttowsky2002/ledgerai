-- BadgerIQ Postgres migration 024 — grant badgeriq_app the API role privileges
--
-- Cloud Run MVP connects as the Cloud SQL login `badgeriq_app` (see the
-- badgeriq-api service env). Migrations 002+ grant table access to the
-- `agentledger_api` NOLOGIN role. This migration makes `badgeriq_app` inherit
-- those grants so RLS-enforced CRUD works without connecting as superuser.
--
-- Run once against badgeriq_prod after the core migrations. Idempotent.
--
-- Forward-only; never edit an applied migration.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'badgeriq_app') THEN
        RAISE EXCEPTION 'role badgeriq_app does not exist — create the Cloud SQL user first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentledger_api') THEN
        RAISE EXCEPTION 'role agentledger_api does not exist — apply migration 002 first';
    END IF;
END
$$;

-- Inherit every grant agentledger_api already has (tables, sequences, functions).
GRANT agentledger_api TO badgeriq_app;

COMMIT;
