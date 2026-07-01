-- AgentLedger Postgres migration 018 — GitHub Copilot Business connector tables
--
-- Extends the connector framework (014) with license/usage/ROI storage for
-- GitHub Copilot Business. ai_provider_connections links to connectors for
-- encrypted token storage and sync status; Copilot-specific facts live in
-- dedicated tables. Enterprise slug is nullable for future enterprise endpoints.
--
-- Forward-only; never edit an applied migration.

CREATE TABLE IF NOT EXISTS ai_provider_connections (
    connection_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connector_id         UUID NOT NULL,
    provider             TEXT NOT NULL DEFAULT 'github_copilot_business',
    connection_type      TEXT NOT NULL DEFAULT 'license_usage_roi',
    org_slug             TEXT NOT NULL,
    enterprise_slug      TEXT,
    display_name         TEXT,
    roi_assumptions      JSONB NOT NULL DEFAULT '{}'::jsonb,
    schedule_json        JSONB NOT NULL DEFAULT '{"frequency":"daily"}'::jsonb,
    last_success_at      TIMESTAMPTZ,
    last_error_code      TEXT,
    last_error_message   TEXT,
    records_imported     INT NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, connector_id),
    UNIQUE (tenant_id, provider, org_slug)
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_connections_tenant
    ON ai_provider_connections (tenant_id, provider);

CREATE TABLE IF NOT EXISTS github_copilot_seats (
    seat_id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connection_id              UUID NOT NULL REFERENCES ai_provider_connections ON DELETE CASCADE,
    org_slug                   TEXT NOT NULL,
    github_user_id             BIGINT NOT NULL,
    github_login               TEXT NOT NULL,
    plan_type                  TEXT,
    assigning_team_slug        TEXT,
    seat_created_at            TIMESTAMPTZ,
    pending_cancellation_date  DATE,
    last_activity_at           TIMESTAMPTZ,
    last_activity_editor       TEXT,
    is_active                  BOOLEAN NOT NULL DEFAULT true,
    monthly_seat_cost          NUMERIC(14, 6) NOT NULL DEFAULT 19,
    synced_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, connection_id, github_user_id)
);

CREATE INDEX IF NOT EXISTS idx_github_copilot_seats_tenant_org
    ON github_copilot_seats (tenant_id, org_slug);
CREATE INDEX IF NOT EXISTS idx_github_copilot_seats_login
    ON github_copilot_seats (tenant_id, github_login);

CREATE TABLE IF NOT EXISTS github_copilot_usage_daily (
    usage_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connection_id        UUID NOT NULL REFERENCES ai_provider_connections ON DELETE CASCADE,
    org_slug               TEXT NOT NULL,
    usage_date             DATE NOT NULL,
    github_login           TEXT NOT NULL DEFAULT '',
    team_slug              TEXT NOT NULL DEFAULT '',
    editor                 TEXT NOT NULL DEFAULT '',
    language               TEXT NOT NULL DEFAULT '',
    model                  TEXT NOT NULL DEFAULT '',
    feature                TEXT NOT NULL DEFAULT '',
    suggestions_count      INT NOT NULL DEFAULT 0,
    acceptances_count      INT NOT NULL DEFAULT 0,
    lines_suggested        INT NOT NULL DEFAULT 0,
    lines_accepted         INT NOT NULL DEFAULT 0,
    active_users           INT NOT NULL DEFAULT 0,
    engaged_users          INT NOT NULL DEFAULT 0,
    chat_turns             INT NOT NULL DEFAULT 0,
    pr_summary_count       INT NOT NULL DEFAULT 0,
    ai_credits_used        NUMERIC(14, 6) NOT NULL DEFAULT 0,
    raw_payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
    synced_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (
        tenant_id,
        connection_id,
        usage_date,
        github_login,
        team_slug,
        editor,
        language,
        model,
        feature
    )
);

CREATE INDEX IF NOT EXISTS idx_github_copilot_usage_daily_tenant_date
    ON github_copilot_usage_daily (tenant_id, usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_github_copilot_usage_daily_login
    ON github_copilot_usage_daily (tenant_id, github_login, usage_date);

CREATE TABLE IF NOT EXISTS github_copilot_roi_daily (
    roi_id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connection_id            UUID NOT NULL REFERENCES ai_provider_connections ON DELETE CASCADE,
    org_slug                   TEXT NOT NULL,
    usage_date                 DATE NOT NULL,
    team_slug                  TEXT NOT NULL DEFAULT '',
    assigned_seats             INT NOT NULL DEFAULT 0,
    active_seats               INT NOT NULL DEFAULT 0,
    base_seat_cost             NUMERIC(14, 6) NOT NULL DEFAULT 0,
    included_ai_credits        NUMERIC(14, 6) NOT NULL DEFAULT 0,
    ai_credits_used            NUMERIC(14, 6) NOT NULL DEFAULT 0,
    overage_estimate           NUMERIC(14, 6) NOT NULL DEFAULT 0,
    total_copilot_cost         NUMERIC(14, 6) NOT NULL DEFAULT 0,
    lines_accepted             INT NOT NULL DEFAULT 0,
    chat_turns                 INT NOT NULL DEFAULT 0,
    pr_summary_count           INT NOT NULL DEFAULT 0,
    gross_hours_saved          NUMERIC(14, 6) NOT NULL DEFAULT 0,
    adjusted_hours_saved       NUMERIC(14, 6) NOT NULL DEFAULT 0,
    estimated_value            NUMERIC(14, 6) NOT NULL DEFAULT 0,
    roi_percentage             NUMERIC(14, 6) NOT NULL DEFAULT 0,
    assumptions_snapshot       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, connection_id, usage_date, team_slug)
);

CREATE INDEX IF NOT EXISTS idx_github_copilot_roi_daily_tenant_date
    ON github_copilot_roi_daily (tenant_id, usage_date DESC);

-- RLS
ALTER TABLE ai_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_provider_connections FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY ai_provider_connections_isolation ON ai_provider_connections
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE github_copilot_seats ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_copilot_seats FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY github_copilot_seats_isolation ON github_copilot_seats
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE github_copilot_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_copilot_usage_daily FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY github_copilot_usage_daily_isolation ON github_copilot_usage_daily
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE github_copilot_roi_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_copilot_roi_daily FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY github_copilot_roi_daily_isolation ON github_copilot_roi_daily
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_provider_connections TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON github_copilot_seats TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON github_copilot_usage_daily TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON github_copilot_roi_daily TO agentledger_api;
