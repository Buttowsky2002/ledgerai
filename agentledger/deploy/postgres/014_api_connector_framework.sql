-- LedgerAI migration 014 — generic API connector framework
--
-- Adds connector definitions (built-in presets + tenant custom), extends the
-- existing connectors table for the NestJS control-plane engine, and adds sync
-- lifecycle + normalized record staging tables. Go connector-sync continues to
-- use kind/config/sync_cursor on the same connectors table (backward compatible).
--
-- Forward-only; never edit an applied migration.

BEGIN;

-- ---------- Connector definition templates (built-in + tenant custom) ----------
CREATE TABLE IF NOT EXISTS connector_definitions (
    definition_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants ON DELETE CASCADE,  -- NULL = built-in preset
    name            TEXT NOT NULL,
    provider        TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT 'custom',
    definition_json JSONB NOT NULL DEFAULT '{}',
    version         INT NOT NULL DEFAULT 1,
    built_in        BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_connector_definitions_builtin ON connector_definitions (built_in) WHERE built_in = true;
CREATE INDEX IF NOT EXISTS idx_connector_definitions_tenant ON connector_definitions (tenant_id) WHERE tenant_id IS NOT NULL;

-- ---------- Encrypted connector credentials (never plaintext) ----------
CREATE TABLE IF NOT EXISTS connector_secrets (
    secret_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    ciphertext   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Extend connectors for API connector engine ----------
ALTER TABLE connectors
    ADD COLUMN IF NOT EXISTS connector_definition_id UUID REFERENCES connector_definitions ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS provider TEXT,
    ADD COLUMN IF NOT EXISTS category TEXT,
    ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS mapping_overrides_json JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS schedule_json JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS last_sync_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_sync_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_error_code TEXT,
    ADD COLUMN IF NOT EXISTS last_error_message_safe TEXT;

-- Backfill display_name from kind for legacy Go connector rows.
UPDATE connectors SET display_name = kind WHERE display_name IS NULL AND kind IS NOT NULL;

-- ---------- Sync runs ----------
CREATE TABLE IF NOT EXISTS connector_sync_runs (
    sync_run_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connector_id             UUID NOT NULL REFERENCES connectors ON DELETE CASCADE,
    status                   TEXT NOT NULL DEFAULT 'running',
    started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at             TIMESTAMPTZ,
    records_seen             INT NOT NULL DEFAULT 0,
    records_imported         INT NOT NULL DEFAULT 0,
    records_rejected         INT NOT NULL DEFAULT 0,
    net_spend_imported_usd     NUMERIC(14, 6) NOT NULL DEFAULT 0,
    gross_spend_imported_usd   NUMERIC(14, 6) NOT NULL DEFAULT 0,
    request_count_imported     INT NOT NULL DEFAULT 0,
    token_count_imported     BIGINT NOT NULL DEFAULT 0,
    error_code               TEXT,
    error_message_safe       TEXT
);

CREATE INDEX IF NOT EXISTS idx_connector_sync_runs_connector ON connector_sync_runs (connector_id, started_at DESC);

-- ---------- Per-record sync errors ----------
CREATE TABLE IF NOT EXISTS connector_sync_errors (
    error_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connector_id       UUID NOT NULL REFERENCES connectors ON DELETE CASCADE,
    sync_run_id        UUID NOT NULL REFERENCES connector_sync_runs ON DELETE CASCADE,
    record_ref         TEXT,
    error_code         TEXT NOT NULL,
    error_message_safe TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_connector_sync_errors_run ON connector_sync_errors (sync_run_id);

-- ---------- Normalized external records (staging + dedupe ledger) ----------
CREATE TABLE IF NOT EXISTS normalized_external_records (
    record_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connector_id       UUID NOT NULL REFERENCES connectors ON DELETE CASCADE,
    sync_run_id        UUID NOT NULL REFERENCES connector_sync_runs ON DELETE CASCADE,
    source_type        TEXT NOT NULL DEFAULT 'api',
    record_type        TEXT NOT NULL,
    provider           TEXT NOT NULL DEFAULT '',
    external_record_id TEXT,
    dedupe_hash        TEXT NOT NULL,
    period_start       TIMESTAMPTZ,
    period_end         TIMESTAMPTZ,
    ts                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    normalized_json    JSONB NOT NULL DEFAULT '{}',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, connector_id, dedupe_hash)
);

CREATE INDEX IF NOT EXISTS idx_normalized_external_records_connector ON normalized_external_records (connector_id, ts DESC);

-- ---------- RLS (idempotent) ----------
ALTER TABLE connector_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_definitions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY connector_definitions_read ON connector_definitions
        FOR SELECT USING (built_in = true OR tenant_id = app_current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY connector_definitions_write ON connector_definitions
        FOR ALL USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant() AND built_in = false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE connector_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_secrets FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY connector_secrets_isolation ON connector_secrets
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE connector_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_sync_runs FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY connector_sync_runs_isolation ON connector_sync_runs
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE connector_sync_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_sync_errors FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY connector_sync_errors_isolation ON connector_sync_errors
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE normalized_external_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE normalized_external_records FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY normalized_external_records_isolation ON normalized_external_records
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON connector_definitions TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON connector_secrets TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON connector_sync_runs TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON connector_sync_errors TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON normalized_external_records TO agentledger_api;

COMMIT;
