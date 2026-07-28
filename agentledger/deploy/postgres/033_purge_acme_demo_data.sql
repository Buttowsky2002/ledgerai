-- BadgerIQ Postgres migration 033 — purge leftover @acme.test identities
--
-- Removes synthetic Acme demo humans that may still exist from older seeds
-- (deploy/demo used to use @acme.test; current seeds use @studiodesigner.test /
-- real @studiodesigner.com). Clears FK refs and pending invites first so the
-- DELETE does not fail on constraints.
--
-- Forward-only; never edit an applied migration. Idempotent.

BEGIN;

-- Drop manager pointers at Acme demo identities before deleting them.
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

-- Pending invites to Acme demo emails, or invited by an Acme identity.
DELETE FROM invites
WHERE email LIKE '%@acme.test'
   OR invited_by IN (
     SELECT user_id FROM identities WHERE email LIKE '%@acme.test'
   );

DELETE FROM identities
WHERE email LIKE '%@acme.test';

-- Rename any remaining Acme-branded tenant display names.
UPDATE tenants
SET name = 'Studio Designer'
WHERE name IN ('Acme Demo Co', 'Acme Corp');

COMMIT;
