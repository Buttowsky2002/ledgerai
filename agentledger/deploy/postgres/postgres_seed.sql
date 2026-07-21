-- BadgerIQ seed — developer + service-account identities for the pilot tenant.
--
-- Root cause of the "99.6% unattributed" analytics issue: ClickHouse events
-- carry user_id / agent_id handles, but Postgres had no identities rows to
-- resolve them against. Without identities the attribution engine has nothing
-- to join on, so every event falls into the unattributed bucket.
--
-- This file adds 5 developer identities and 3 service-account identities,
-- each with:
--   • email              — primary lookup key
--   • external_id        — OAuth / OIDC subject identifier (for SSO resolution)
--   • aliases (JSONB)    — additional provider handles the attribution engine
--                          matches against (git emails, API key names, etc.)
--
-- The identities.aliases JSONB column + external_id column together serve the
-- role of an identity_aliases table (001_core.sql, 008_sso_identity.sql).
--
-- Tenant UUID: 00000000-0000-4000-8000-000000000001
-- (matches migration 015_connector_kind_nullable.sql and LEDGERAI_DEV_TENANT_ID)
--
-- Usage:
--   psql <dsn> -v ON_ERROR_STOP=1 -f postgres_seed.sql

BEGIN;

-- The tenant must already exist (created by 015_connector_kind_nullable.sql).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tenants WHERE tenant_id = '00000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'Tenant 00000000-0000-4000-8000-000000000001 does not exist. Run schema migrations first.';
  END IF;
END $$;

-- ── Developer identities ────────────────────────────────────────────────────

INSERT INTO identities (tenant_id, email, display_name, role, source, external_id, aliases)
VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'dev-1@example.com',
    'Dev One',
    'member',
    'manual',
    'oauth|dev-1|a1b2c3d4e5f6',
    '["dev-1@example.com", "dev-one@github"]'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    'dev-2@example.com',
    'Dev Two',
    'member',
    'manual',
    'oauth|dev-2|b2c3d4e5f6a1',
    '["dev-2@example.com", "dev-two@github"]'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    'dev-3@example.com',
    'Dev Three',
    'member',
    'manual',
    'oauth|dev-3|c3d4e5f6a1b2',
    '["dev-3@example.com", "dev-three@github"]'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    'dev-4@example.com',
    'Dev Four',
    'admin',
    'manual',
    'oauth|dev-4|d4e5f6a1b2c3',
    '["dev-4@example.com", "dev-four@github"]'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    'dev-5@example.com',
    'Dev Five',
    'member',
    'manual',
    'oauth|dev-5|e5f6a1b2c3d4',
    '["dev-5@example.com", "dev-five@github"]'::jsonb
  )
ON CONFLICT (tenant_id, email) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      external_id  = EXCLUDED.external_id,
      aliases      = EXCLUDED.aliases;

-- ── Service-account identities ──────────────────────────────────────────────

INSERT INTO identities (tenant_id, email, display_name, role, source, external_id, aliases)
VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'svc-ci-runner@example.com',
    'CI Runner (service account)',
    'member',
    'manual',
    'oauth|svc-ci|f6a1b2c3d4e5',
    '["svc-ci-runner@example.com", "github-actions-bot"]'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    'svc-deploy-bot@example.com',
    'Deploy Bot (service account)',
    'member',
    'manual',
    'oauth|svc-deploy|a1c3e5b2d4f6',
    '["svc-deploy-bot@example.com", "deploy-bot@argocd"]'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    'svc-data-pipeline@example.com',
    'Data Pipeline (service account)',
    'member',
    'manual',
    'oauth|svc-pipeline|b2d4f6a1c3e5',
    '["svc-data-pipeline@example.com", "airflow-scheduler"]'::jsonb
  )
ON CONFLICT (tenant_id, email) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      external_id  = EXCLUDED.external_id,
      aliases      = EXCLUDED.aliases;

COMMIT;
