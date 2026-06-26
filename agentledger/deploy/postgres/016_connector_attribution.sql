-- AgentLedger migration 016 — connector attribution mappings + sync stats
-- Forward-only; never edit an applied migration.

BEGIN;

-- Manual mappings from provider keys (API key, project, workspace, etc.) to users/teams.
CREATE TABLE IF NOT EXISTS connector_attribution_mappings (
    mapping_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connector_id     UUID NOT NULL REFERENCES connectors ON DELETE CASCADE,
    mapping_type     TEXT NOT NULL,
    provider_key     TEXT NOT NULL,
    provider_key_name TEXT,
    target_user_id   TEXT,
    target_team_id   TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, connector_id, mapping_type, provider_key)
);

CREATE INDEX IF NOT EXISTS idx_connector_attr_mappings_connector
    ON connector_attribution_mappings (connector_id);

-- Provider entities discovered during sync (users, projects, API keys).
CREATE TABLE IF NOT EXISTS connector_provider_entities (
    entity_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connector_id UUID NOT NULL REFERENCES connectors ON DELETE CASCADE,
    entity_type  TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    display_name TEXT,
    email        TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}',
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, connector_id, entity_type, provider_key)
);

CREATE INDEX IF NOT EXISTS idx_connector_provider_entities_connector
    ON connector_provider_entities (connector_id, entity_type);

-- Extended sync run stats for Data Sources UI.
ALTER TABLE connector_sync_runs
    ADD COLUMN IF NOT EXISTS users_detected INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS unmapped_records INT NOT NULL DEFAULT 0;

ALTER TABLE connector_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_sync_runs FORCE ROW LEVEL SECURITY;

ALTER TABLE connector_attribution_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_attribution_mappings FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY connector_attribution_mappings_isolation ON connector_attribution_mappings
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE connector_provider_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_provider_entities FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY connector_provider_entities_isolation ON connector_provider_entities
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON connector_attribution_mappings TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON connector_provider_entities TO agentledger_api;

COMMIT;
