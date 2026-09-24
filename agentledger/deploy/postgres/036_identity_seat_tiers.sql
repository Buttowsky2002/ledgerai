-- AgentLedger Postgres migration 036 — per-user seat tiers (basic/premium)
--
-- Marks which Fixed Overhead seat pool a person consumes per vendor. Tagging
-- premium never adds spend — it only moves the user from the basic pool into
-- the premium pool when allocating fixed_costs onto the Users / CFO views.
--
-- Forward-only; never edit an applied migration.

CREATE TABLE IF NOT EXISTS identity_seat_tiers (
    tenant_id UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    user_id   UUID NOT NULL REFERENCES identities(user_id) ON DELETE CASCADE,
    vendor    TEXT NOT NULL,
    tier      TEXT NOT NULL DEFAULT 'basic'
                CHECK (tier IN ('basic', 'premium')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, vendor)
);

CREATE INDEX IF NOT EXISTS idx_identity_seat_tiers_user
    ON identity_seat_tiers (tenant_id, user_id);

COMMENT ON TABLE identity_seat_tiers IS
    'Per-identity, per-vendor seat class (basic|premium) for Fixed Overhead allocation.';

ALTER TABLE identity_seat_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_seat_tiers FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'identity_seat_tiers' AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON identity_seat_tiers
            USING (tenant_id = app_current_tenant())
            WITH CHECK (tenant_id = app_current_tenant());
    END IF;
EXCEPTION
    WHEN undefined_function THEN
        RAISE NOTICE 'app_current_tenant() missing — apply migration 002_rls.sql first';
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON identity_seat_tiers TO agentledger_api;
