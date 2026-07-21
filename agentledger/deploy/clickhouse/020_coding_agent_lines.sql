-- BadgerIQ ClickHouse migration 020 — coding agent line/commit activity (Cursor daily usage)
-- Populated by cursor-usage connector companion fetch → coding_agent_daily.

ALTER TABLE agentledger.coding_agent_daily
    ADD COLUMN IF NOT EXISTS lines_accepted UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lines_added UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lines_deleted UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lines_committed UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tabs_accepted UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS composer_requests UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS chat_requests UInt32 DEFAULT 0;
