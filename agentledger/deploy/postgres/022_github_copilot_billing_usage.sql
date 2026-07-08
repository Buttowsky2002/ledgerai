-- BadgerIQ Postgres migration 022 — GitHub Copilot billing usage (invoice-grade)
--
-- Stores per-user/day/model lines from GitHub's billing AI credit usage API
-- (same fields as the downloadable usage CSV). Member spend v2 uses net_amount
-- for allocated cost when billing rows exist for a day.
--
-- Forward-only; never edit an applied migration.

CREATE TABLE IF NOT EXISTS github_copilot_billing_lines (
    billing_line_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    connection_id     UUID NOT NULL REFERENCES ai_provider_connections ON DELETE CASCADE,
    org_slug          TEXT NOT NULL,
    usage_date        DATE NOT NULL,
    github_login      TEXT NOT NULL,
    product           TEXT NOT NULL DEFAULT '',
    sku               TEXT NOT NULL DEFAULT '',
    model             TEXT NOT NULL DEFAULT '',
    unit_type         TEXT NOT NULL DEFAULT '',
    gross_quantity    NUMERIC(14, 6) NOT NULL DEFAULT 0,
    gross_amount      NUMERIC(14, 6) NOT NULL DEFAULT 0,
    discount_amount   NUMERIC(14, 6) NOT NULL DEFAULT 0,
    net_amount        NUMERIC(14, 6) NOT NULL DEFAULT 0,
    raw_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, connection_id, usage_date, github_login, sku, model)
);

CREATE INDEX IF NOT EXISTS idx_github_copilot_billing_lines_date
    ON github_copilot_billing_lines (tenant_id, usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_github_copilot_billing_lines_login
    ON github_copilot_billing_lines (tenant_id, github_login, usage_date);

ALTER TABLE github_copilot_member_spend_daily
    ADD COLUMN IF NOT EXISTS billed_net_usd NUMERIC(14, 6) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS billed_gross_usd NUMERIC(14, 6) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS billing_credits NUMERIC(14, 6) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cost_source TEXT NOT NULL DEFAULT 'estimate';

ALTER TABLE github_copilot_member_spend_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_copilot_member_spend_daily FORCE ROW LEVEL SECURITY;

ALTER TABLE github_copilot_billing_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_copilot_billing_lines FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY github_copilot_billing_lines_isolation ON github_copilot_billing_lines
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON github_copilot_billing_lines TO agentledger_api;
