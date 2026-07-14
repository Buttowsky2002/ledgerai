-- Cursor / Copilot daily activity lines for productivity ROI (Cursor Admin daily-usage-data).

ALTER TABLE coding_agent_daily
    ADD COLUMN IF NOT EXISTS lines_accepted bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lines_added bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lines_deleted bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lines_committed bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tabs_accepted bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS composer_requests bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS chat_requests bigint NOT NULL DEFAULT 0;
