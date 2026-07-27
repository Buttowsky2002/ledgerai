-- Rename legacy demo tenant branding to Studio Designer.
-- Idempotent: only rewrites known Acme demo display names.
UPDATE tenants
SET name = 'Studio Designer'
WHERE name IN ('Acme Demo Co', 'Acme Corp');
