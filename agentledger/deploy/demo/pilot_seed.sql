-- Pilot seed overlay — run AFTER postgres_seed.sql to configure the demo tenant
-- for production OIDC login. Updates api_role for known pilot users so they can
-- actually administer the dashboard.
--
-- Usage: psql -v tenant=<uuid> -f pilot_seed.sql
--
-- This is idempotent and forward-only.

-- Promote the pilot admin to api_role = 'admin' (OIDC login resolves by email).
UPDATE identities
SET api_role = 'admin'
WHERE tenant_id = :'tenant'
  AND email = 'brandon.balams@studiodesigner.com';

-- Promote a second user as backup admin.
UPDATE identities
SET api_role = 'admin'
WHERE tenant_id = :'tenant'
  AND email = 'brandon@studiodesigner.com';

-- Give finance users analyst access (can see spend/ROI but not modify settings).
UPDATE identities
SET api_role = 'analyst'
WHERE tenant_id = :'tenant'
  AND email IN (
    'russ.mcclelland@smartobjx.com',
    'david.jeong@studiodesigner.com'
  );

-- Ensure the active flag is set for all seeded identities (migration 008 added
-- it with DEFAULT true, but explicit is better for a pilot).
UPDATE identities
SET active = true
WHERE tenant_id = :'tenant'
  AND active IS NOT NULL;
