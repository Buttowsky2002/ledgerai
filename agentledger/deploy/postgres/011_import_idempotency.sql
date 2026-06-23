-- LedgerAI Postgres migration 011 — import idempotency ledger
--
-- Tracks idempotency keys seen by POST /v1/import/events so a re-import with the
-- same keys is skipped (no double counting). Tenant-scoped + RLS like every other
-- control-plane table. Forward-only; never edit an applied migration.

BEGIN;

CREATE TABLE import_idempotency (
    tenant_id       UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, idempotency_key)
);

-- RLS: a connection only sees/writes its own tenant's keys (app.tenant_id GUC).
ALTER TABLE import_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_idempotency
    USING (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

-- The least-privilege API role (created in 002) needs read/insert only — the
-- import path never deletes (tenant teardown relies on the ON DELETE CASCADE from
-- tenants, which runs as the table owner). ALTER DEFAULT PRIVILEGES already covers
-- tables created by the migration owner, but grant explicitly to be safe.
GRANT SELECT, INSERT ON import_idempotency TO agentledger_api;

COMMIT;
