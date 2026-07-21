-- BadgerIQ Postgres migration 028 — purge Acme/demo seed artifacts
--
-- Removes synthetic @acme.test identities and the eight named demo agents (plus
-- their agent-scoped budgets) while keeping real SSO users, teams, connectors,
-- and IdP config. Renames the well-known demo tenant away from "Acme Demo Co".
--
-- Forward-only; never edit an applied migration. Does NOT drop the tenant row
-- (real OIDC identities may live on 00000000-0000-4000-8000-000000000001).

BEGIN;

-- Synthetic demo humans from deploy/demo/postgres_seed.sql
DELETE FROM identities
WHERE email LIKE '%@acme.test';

-- Budgets scoped to the eight demo agent names (scope_id stores the agent name).
DELETE FROM budgets
WHERE scope_type = 'agent'
  AND scope_id IN (
    'SupportBot',
    'InvoiceReviewAgent',
    'SOC-TriageAgent',
    'SalesResearchAgent',
    'CodeReviewAgent',
    'DataCleanupAgent',
    'RefundApprovalAgent',
    'ContractSummarizerAgent'
  );

-- Demo story agents only — leave any customer-created agents alone.
DELETE FROM agents
WHERE name IN (
  'SupportBot',
  'InvoiceReviewAgent',
  'SOC-TriageAgent',
  'SalesResearchAgent',
  'CodeReviewAgent',
  'DataCleanupAgent',
  'RefundApprovalAgent',
  'ContractSummarizerAgent'
);

-- Rename the seeded control-plane tenant if it still carries the Acme label.
UPDATE tenants
SET name = 'Studio Designer'
WHERE tenant_id = '00000000-0000-4000-8000-000000000001'
  AND name = 'Acme Demo Co';

COMMIT;
