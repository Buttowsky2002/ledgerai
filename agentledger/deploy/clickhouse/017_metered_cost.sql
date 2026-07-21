-- BadgerIQ ClickHouse migration 017 — universal metered cost on llm_calls
--
-- metered_cost_usd is what FinOps headline/user/platform totals sum.
-- cost_source distinguishes provider-reported vs price-book estimate rows.

ALTER TABLE agentledger.llm_calls
    ADD COLUMN IF NOT EXISTS cost_source LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS metered_cost_usd Float64 DEFAULT 0;
