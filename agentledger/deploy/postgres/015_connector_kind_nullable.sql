-- BadgerIQ migration 015 — API connector framework follow-ups
-- kind is optional for config-driven API connectors (Go sync rows still use kind).

BEGIN;

ALTER TABLE connectors ALTER COLUMN kind DROP NOT NULL;

-- Demo tenant for local/docker dashboard (id matches BADGERIQ_DEV_TENANT_ID).
INSERT INTO tenants (tenant_id, name, plan)
VALUES ('00000000-0000-4000-8000-000000000001', 'Acme Demo Co', 'enterprise')
ON CONFLICT (tenant_id) DO NOTHING;

COMMIT;
