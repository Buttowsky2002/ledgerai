-- BadgerIQ ClickHouse migration 016 — Cursor billed vs usage-value split
--
-- Cursor Admin API chargedCents reflects usage value on Included rows and
-- invoice overage on On-Demand rows. Store both: cost_usd = billed only,
-- usage_value_usd = full attributed chargedCents/100.

ALTER TABLE agentledger.llm_calls
    ADD COLUMN IF NOT EXISTS usage_value_usd Float64 DEFAULT 0;
