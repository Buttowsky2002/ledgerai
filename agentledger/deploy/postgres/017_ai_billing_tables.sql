-- AgentLedger Postgres migration 017 — AI provider billing & seat inventory
--
-- Control-plane tables for subscription/seat costs that feed LARI fully-loaded
-- cost (subscription_cost_allocated). Tenant-scoped + RLS like every other table.
-- connector_sync_runs (014) already tracks sync history — not duplicated here.
--
-- Forward-only; never edit an applied migration.

CREATE TABLE IF NOT EXISTS ai_provider_accounts (
    account_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    provider             TEXT NOT NULL,
    external_account_id  TEXT NOT NULL,
    display_name         TEXT,
    user_id              UUID,
    team_id              UUID,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, provider, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_accounts_tenant ON ai_provider_accounts (tenant_id, provider);

CREATE TABLE IF NOT EXISTS ai_subscription_plans (
    plan_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    provider                 TEXT NOT NULL,
    external_account_id      TEXT,
    plan_name                TEXT NOT NULL,
    plan_type                TEXT NOT NULL DEFAULT 'seat',
    monthly_price_per_user   NUMERIC(14, 6) NOT NULL DEFAULT 0,
    seats_purchased          INT NOT NULL DEFAULT 0,
    contract_monthly_cost    NUMERIC(14, 6) NOT NULL DEFAULT 0,
    billing_period_start     DATE,
    billing_period_end       DATE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_subscription_plans_tenant ON ai_subscription_plans (tenant_id, provider);

CREATE TABLE IF NOT EXISTS ai_seats (
    seat_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    plan_id              UUID NOT NULL REFERENCES ai_subscription_plans ON DELETE CASCADE,
    provider             TEXT NOT NULL,
    external_account_id  TEXT,
    user_id              UUID,
    team_id              UUID,
    seats_assigned       INT NOT NULL DEFAULT 1,
    active               BOOLEAN NOT NULL DEFAULT true,
    last_active_at       TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_seats_tenant ON ai_seats (tenant_id, provider);
CREATE INDEX IF NOT EXISTS idx_ai_seats_plan ON ai_seats (plan_id);

CREATE TABLE IF NOT EXISTS ai_coding_agent_usage (
    usage_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    provider             TEXT NOT NULL,
    external_account_id  TEXT,
    user_id              UUID,
    team_id              UUID,
    agent_id             TEXT,
    run_id               TEXT,
    tool_name            TEXT,
    cost_usd             NUMERIC(14, 6) NOT NULL DEFAULT 0,
    sessions             INT NOT NULL DEFAULT 0,
    requests             INT NOT NULL DEFAULT 0,
    period_start         TIMESTAMPTZ,
    period_end           TIMESTAMPTZ,
    connector_id         UUID,
    sync_run_id          UUID,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_coding_agent_usage_tenant ON ai_coding_agent_usage (tenant_id, provider, period_start);

-- RLS
ALTER TABLE ai_provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_provider_accounts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY ai_provider_accounts_isolation ON ai_provider_accounts
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE ai_subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_subscription_plans FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY ai_subscription_plans_isolation ON ai_subscription_plans
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE ai_seats ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_seats FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY ai_seats_isolation ON ai_seats
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE ai_coding_agent_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_coding_agent_usage FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY ai_coding_agent_usage_isolation ON ai_coding_agent_usage
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_provider_accounts TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_subscription_plans TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_seats TO agentledger_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_coding_agent_usage TO agentledger_api;
