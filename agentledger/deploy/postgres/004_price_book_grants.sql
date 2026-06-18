-- AgentLedger Postgres migration 004 — price_book write grants for the API
--
-- price_book is GLOBAL reference data (no tenant_id, no RLS). Migration 002 made
-- it read-only for agentledger_api ("global reference data: read-only for the API
-- role"). Phase 3 task 3 makes the control-plane API the management surface for the
-- price book, so the API role now needs write access. Authorization is enforced at
-- the application layer instead of RLS: price-book writes require the `admin` role
-- (@Roles('admin')); reads require `viewer`. See ADR-012.
--
-- Forward-only; never edit an applied migration.

BEGIN;

GRANT INSERT, UPDATE, DELETE ON price_book TO agentledger_api;

COMMIT;
