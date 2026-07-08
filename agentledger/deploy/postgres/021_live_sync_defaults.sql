-- BadgerIQ migration 021 — near-live connector sync defaults (5-minute cadence).
-- Forward-only; never edit an applied migration.

CREATE OR REPLACE FUNCTION connector_scheduled_sync()
RETURNS TABLE(connector_id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.connector_id, c.tenant_id
  FROM connectors c
  WHERE c.enabled = true
    AND COALESCE(c.kind, '') <> 'github-copilot-business'
    AND COALESCE((c.schedule_json->>'enabled')::boolean, true) = true
    AND NOT (
      c.status = 'syncing'
      AND c.last_sync_started_at IS NOT NULL
      AND c.last_sync_started_at > NOW() - interval '15 minutes'
    )
    AND (
      c.last_success_at IS NULL
      OR c.last_success_at < NOW() - (
        GREATEST(COALESCE((c.schedule_json->>'intervalMinutes')::int, 5), 5) || ' minutes'
      )::interval
    );
$$;

CREATE OR REPLACE FUNCTION copilot_scheduled_connections()
RETURNS TABLE(connection_id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.connection_id, c.tenant_id
  FROM ai_provider_connections c
  JOIN connectors k ON k.connector_id = c.connector_id
  WHERE c.provider = 'github_copilot_business'
    AND k.enabled = true
    AND COALESCE((c.schedule_json->>'enabled')::boolean, true) = true
    AND NOT (
      k.status = 'syncing'
      AND k.last_sync_started_at IS NOT NULL
      AND k.last_sync_started_at > NOW() - interval '15 minutes'
    )
    AND (
      c.last_success_at IS NULL
      OR c.last_success_at < NOW() - (
        GREATEST(COALESCE((c.schedule_json->>'intervalMinutes')::int, 5), 5) || ' minutes'
      )::interval
    );
$$;

-- Upgrade connectors still on the old hourly default to 5-minute live sync.
UPDATE connectors
SET schedule_json = jsonb_set(schedule_json, '{intervalMinutes}', '5'::jsonb, true)
WHERE COALESCE((schedule_json->>'intervalMinutes')::int, 60) = 60;

UPDATE ai_provider_connections
SET schedule_json = jsonb_set(schedule_json, '{intervalMinutes}', '5'::jsonb, true)
WHERE COALESCE((schedule_json->>'intervalMinutes')::int, 60) = 60;
