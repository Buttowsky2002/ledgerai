-- BadgerIQ Postgres migration 026 — portal billing import run history
--
-- Tracks each portal CSV import batch so operators can review and delete
-- imported spend surgically. Rows in llm_calls are tagged with import_run_id.
-- Forward-only; never edit an applied migration.

BEGIN;

CREATE TABLE portal_import_runs (
    import_run_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    source          TEXT NOT NULL DEFAULT 'portal_import',
    provider        TEXT NOT NULL DEFAULT 'mixed',
    providers       TEXT[] NOT NULL DEFAULT '{}',
    file_names      TEXT[] NOT NULL DEFAULT '{}',
    date_from       DATE,
    date_to         DATE,
    rows_parsed     INTEGER NOT NULL DEFAULT 0,
    rows_imported   INTEGER NOT NULL DEFAULT 0,
    rows_skipped    INTEGER NOT NULL DEFAULT 0,
    total_cost_usd  DOUBLE PRECISION NOT NULL DEFAULT 0,
    actor           TEXT NOT NULL DEFAULT 'system',
    status          TEXT NOT NULL DEFAULT 'active',
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_portal_import_runs_tenant_created
    ON portal_import_runs (tenant_id, created_at DESC);

ALTER TABLE portal_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_import_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_import_runs
    USING (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON portal_import_runs TO agentledger_api;

ALTER TABLE llm_calls
    ADD COLUMN IF NOT EXISTS import_run_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS llm_calls_import_run
    ON llm_calls (tenant_id, import_run_id)
    WHERE import_run_id <> '';

COMMIT;
