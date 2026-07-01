-- BadgerIQ Postgres migration 019 — GitHub Copilot member spend attribution
--
-- Adds org members, team membership, and persisted per-member daily allocated spend.
-- Extends seats with raw_payload for debugging. ROI thresholds remain in
-- ai_provider_connections.roi_assumptions JSONB (extends github_copilot_roi_settings).
--
-- Forward-only; never edit an applied migration.

CREATE TABLE IF NOT EXISTS github_copilot_members (
    member_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connection_id    UUID NOT NULL REFERENCES ai_provider_connections ON DELETE CASCADE,
    org_slug         TEXT NOT NULL,
    github_user_id   BIGINT NOT NULL,
    github_login     TEXT NOT NULL,
    display_name     TEXT,
    email            TEXT,
    avatar_url       TEXT,
    role             TEXT,
    is_org_member    BOOLEAN NOT NULL DEFAULT true,
    synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, connection_id, github_user_id)
);

CREATE INDEX IF NOT EXISTS idx_github_copilot_members_login
    ON github_copilot_members (tenant_id, github_login);

CREATE TABLE IF NOT EXISTS github_copilot_member_teams (
    member_team_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connection_id    UUID NOT NULL REFERENCES ai_provider_connections ON DELETE CASCADE,
    org_slug         TEXT NOT NULL,
    github_login     TEXT NOT NULL,
    team_slug        TEXT NOT NULL,
    team_name        TEXT NOT NULL DEFAULT '',
    synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, connection_id, github_login, team_slug)
);

CREATE INDEX IF NOT EXISTS idx_github_copilot_member_teams_team
    ON github_copilot_member_teams (tenant_id, team_slug);

CREATE TABLE IF NOT EXISTS github_copilot_member_spend_daily (
    spend_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connection_id            UUID NOT NULL REFERENCES ai_provider_connections ON DELETE CASCADE,
    org_slug                 TEXT NOT NULL,
    usage_date               DATE NOT NULL,
    github_login             TEXT NOT NULL,
    team_slug                TEXT NOT NULL DEFAULT '',
    seat_cost                NUMERIC(14, 6) NOT NULL DEFAULT 0,
    estimated_credit_cost    NUMERIC(14, 6) NOT NULL DEFAULT 0,
    allocated_overage_cost   NUMERIC(14, 6) NOT NULL DEFAULT 0,
    total_allocated_cost     NUMERIC(14, 6) NOT NULL DEFAULT 0,
    ai_credits_used          NUMERIC(14, 6) NOT NULL DEFAULT 0,
    lines_accepted           INT NOT NULL DEFAULT 0,
    chat_turns               INT NOT NULL DEFAULT 0,
    pr_summary_count         INT NOT NULL DEFAULT 0,
    estimated_hours_saved    NUMERIC(14, 6) NOT NULL DEFAULT 0,
    estimated_value_created  NUMERIC(14, 6) NOT NULL DEFAULT 0,
    roi_percentage           NUMERIC(14, 6),
    utilization_status       TEXT NOT NULL DEFAULT 'active',
    confidence_score         NUMERIC(5, 4) NOT NULL DEFAULT 0.85,
    calculation_version      TEXT NOT NULL DEFAULT 'v1',
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, connection_id, usage_date, github_login, team_slug)
);

CREATE INDEX IF NOT EXISTS idx_github_copilot_member_spend_daily_date
    ON github_copilot_member_spend_daily (tenant_id, usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_github_copilot_member_spend_daily_login
    ON github_copilot_member_spend_daily (tenant_id, github_login, usage_date);

ALTER TABLE github_copilot_seats
    ADD COLUMN IF NOT EXISTS raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Background scheduler: list daily Copilot connections across tenants (SECURITY DEFINER).
CREATE OR REPLACE FUNCTION copilot_scheduled_connections()
RETURNS TABLE(connection_id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.connection_id, c.tenant_id
  FROM ai_provider_connections c
  WHERE c.provider = 'github_copilot_business'
    AND COALESCE(c.schedule_json->>'frequency', 'daily') = 'daily';
$$;

GRANT EXECUTE ON FUNCTION copilot_scheduled_connections() TO agentledger_api;

-- RLS
ALTER TABLE github_copilot_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_copilot_members FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY github_copilot_members_isolation ON github_copilot_members
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE github_copilot_member_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_copilot_member_teams FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY github_copilot_member_teams_isolation ON github_copilot_member_teams
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE github_copilot_member_spend_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_copilot_member_spend_daily FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY github_copilot_member_spend_daily_isolation ON github_copilot_member_spend_daily
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON github_copilot_members TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON github_copilot_member_teams TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON github_copilot_member_spend_daily TO agentledger_api;
