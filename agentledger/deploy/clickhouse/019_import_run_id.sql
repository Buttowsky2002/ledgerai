-- BadgerIQ ClickHouse migration 019 — tag portal imports with run id for surgical delete

ALTER TABLE agentledger.llm_calls
    ADD COLUMN IF NOT EXISTS import_run_id String DEFAULT '';
