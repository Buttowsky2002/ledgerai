-- AgentLedger Postgres migration 034 — business criticality tiers
--
-- Adds tenant-configured criticality to people and subscription plans so LARI
-- can dampen recommendation urgency without performing I/O in its pure engine.
--
-- Forward-only; never edit an applied migration.

ALTER TABLE identities
    ADD COLUMN criticality_tier TEXT NOT NULL DEFAULT 'standard';

COMMENT ON COLUMN identities.criticality_tier IS
    'Business criticality used by LARI recommendation scoring: low|standard|high|critical.';

ALTER TABLE ai_subscription_plans
    ADD COLUMN criticality_tier TEXT NOT NULL DEFAULT 'standard';

COMMENT ON COLUMN ai_subscription_plans.criticality_tier IS
    'Business criticality used by LARI recommendation scoring: low|standard|high|critical.';

-- Recreate the unified view after the column exists. The new output column is
-- appended because PostgreSQL CREATE OR REPLACE VIEW preserves existing order.
CREATE OR REPLACE VIEW v_identities WITH (security_invoker = true) AS
SELECT
    i.user_id            AS identity_id,
    i.tenant_id          AS tenant_id,
    'human'::text        AS identity_type,
    i.display_name       AS display_name,
    i.email              AS email,
    i.team_id            AS team_id,
    i.role               AS role,
    NULL::uuid           AS owner_user_id,
    NULL::text           AS runtime_type,
    NULL::text           AS approval_status,
    NULL::timestamptz    AS decommissioned_at,
    i.criticality_tier   AS criticality_tier
FROM identities i
UNION ALL
SELECT
    a.agent_id           AS identity_id,
    a.tenant_id          AS tenant_id,
    'agent'::text        AS identity_type,
    a.name               AS display_name,
    NULL::text           AS email,
    NULL::uuid           AS team_id,
    NULL::text           AS role,
    a.owner_user_id      AS owner_user_id,
    a.runtime_type       AS runtime_type,
    a.approval_status    AS approval_status,
    a.decommissioned_at  AS decommissioned_at,
    NULL::text           AS criticality_tier
FROM agents a;
