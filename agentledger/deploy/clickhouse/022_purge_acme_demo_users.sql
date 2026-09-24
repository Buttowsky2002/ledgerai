-- BadgerIQ ClickHouse migration 022 — purge @acme.test / demo-user-* analytics
--
-- Historical demo seed used @acme.test emails and demo-user-N handles as
-- llm_calls.user_id. After Postgres identities were purged those rows still
-- resurfaced in the Users directory as unlinked members. Delete them so the
-- directory stays clean. Lightweight mutations; safe to re-run.
--
-- Forward-only; never edit an applied migration.

ALTER TABLE agentledger.llm_calls
  DELETE WHERE user_id LIKE '%@acme.test' OR match(user_id, '^demo-user-[0-9]+$')
  SETTINGS mutations_sync = 1;

ALTER TABLE agentledger.agent_runs
  DELETE WHERE user_id LIKE '%@acme.test' OR match(user_id, '^demo-user-[0-9]+$')
  SETTINGS mutations_sync = 1;

ALTER TABLE agentledger.coding_agent_daily
  DELETE WHERE user_id LIKE '%@acme.test' OR match(user_id, '^demo-user-[0-9]+$')
  SETTINGS mutations_sync = 1;

-- SummingMergeTree / view targets: clear Acme keys when the physical table exists.
ALTER TABLE agentledger.spend_daily_by_user
  DELETE WHERE user_id LIKE '%@acme.test' OR match(user_id, '^demo-user-[0-9]+$')
  SETTINGS mutations_sync = 1;
