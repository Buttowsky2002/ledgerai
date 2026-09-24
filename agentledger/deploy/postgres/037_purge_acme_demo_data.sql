-- BadgerIQ Postgres migration 037 — re-purge @acme.test demo identities
--
-- Migration 033 deleted Acme demo humans once, but historical analytics rows
-- (and occasional re-seeds) can leave @acme.test identities / FK refs behind.
-- This migration is idempotent and also clears tables added since 033
-- (identity_seat_tiers, ai_seats) plus Postgres analytics mirrors.
--
-- Forward-only; never edit an applied migration.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.identity_seat_tiers') IS NOT NULL THEN
    DELETE FROM identity_seat_tiers
    WHERE user_id IN (SELECT user_id FROM identities WHERE email LIKE '%@acme.test');
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.ai_seats') IS NOT NULL THEN
    UPDATE ai_seats
    SET user_id = NULL
    WHERE user_id IN (SELECT user_id FROM identities WHERE email LIKE '%@acme.test');
  END IF;
END
$$;

UPDATE identities
SET manager_id = NULL
WHERE manager_id IN (
  SELECT user_id FROM identities WHERE email LIKE '%@acme.test'
);

UPDATE apps
SET owner_user_id = NULL
WHERE owner_user_id IN (
  SELECT user_id FROM identities WHERE email LIKE '%@acme.test'
);

UPDATE agents
SET owner_user_id = NULL
WHERE owner_user_id IN (
  SELECT user_id FROM identities WHERE email LIKE '%@acme.test'
);

UPDATE virtual_keys
SET user_id = NULL
WHERE user_id IN (
  SELECT user_id FROM identities WHERE email LIKE '%@acme.test'
);

UPDATE allocation_rules
SET owner_user_id = NULL
WHERE owner_user_id IN (
  SELECT user_id FROM identities WHERE email LIKE '%@acme.test'
);

DELETE FROM invites
WHERE email LIKE '%@acme.test'
   OR invited_by IN (
     SELECT user_id FROM identities WHERE email LIKE '%@acme.test'
   );

DELETE FROM identities
WHERE email LIKE '%@acme.test';

-- Postgres analytics mirror (BADGERIQ_ANALYTICS_BACKEND=postgres): drop Acme
-- spend/presence so the Users directory cannot resurrect them from llm_calls.
DO $$
BEGIN
  IF to_regclass('public.llm_calls') IS NOT NULL THEN
    DELETE FROM llm_calls
    WHERE user_id ILIKE '%@acme.test'
       OR user_id ~ '^demo-user-[0-9]+$';
  END IF;
  IF to_regclass('public.agent_runs') IS NOT NULL THEN
    DELETE FROM agent_runs
    WHERE user_id ILIKE '%@acme.test'
       OR user_id ~ '^demo-user-[0-9]+$';
  END IF;
  IF to_regclass('public.coding_agent_daily') IS NOT NULL THEN
    DELETE FROM coding_agent_daily
    WHERE user_id ILIKE '%@acme.test'
       OR user_id ~ '^demo-user-[0-9]+$';
  END IF;
END
$$;

UPDATE tenants
SET name = 'Studio Designer'
WHERE name IN ('Acme Demo Co', 'Acme Corp');

COMMIT;
