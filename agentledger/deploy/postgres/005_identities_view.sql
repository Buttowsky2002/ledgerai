-- AgentLedger Postgres migration 005 — unified identity graph (NHIs first-class)
--
-- CLAUDE.md Phase 3 requires "identities as first-class incl. non-human
-- identities (NHIs) for agents". Humans live in `identities`, agents in the
-- `agents` registry. v_identities unifies them into one identity set keyed by a
-- single identity_id with identity_type (human|agent), so an agent is a graph
-- node alongside its human owner — without a destructive refactor of either
-- base table (RLS policies, API and dashboard keep using identities/agents).
--
-- security_invoker = true so the view runs with the QUERYING role's privileges
-- and the tenant RLS on identities/agents (FORCE RLS, 002_rls.sql) applies — the
-- API connects as agentledger_api, which is subject to those policies. Without
-- it the view would run as its owner and could leak across tenants.
--
-- Forward-only; never edit an applied migration.

BEGIN;

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
    NULL::timestamptz    AS decommissioned_at
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
    a.decommissioned_at  AS decommissioned_at
FROM agents a;

COMMENT ON VIEW v_identities IS
    'Unified human + non-human (agent) identities for the Agent Outcome Graph (Phase 3). identity_type: human|agent. security_invoker so tenant RLS applies as the querying role.';

GRANT SELECT ON v_identities TO agentledger_api;

COMMIT;
