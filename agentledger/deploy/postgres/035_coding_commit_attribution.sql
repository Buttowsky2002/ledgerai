-- Coding commit attribution (Cursor Enterprise /analytics/ai-code/commits).
-- Mirrors ClickHouse coding_commit_attribution for the Postgres analytics MVP.

CREATE TABLE IF NOT EXISTS coding_commit_attribution (
    tenant_id            text NOT NULL,
    source_tool          text NOT NULL DEFAULT 'cursor',
    commit_hash          text NOT NULL,
    identity_email       text NOT NULL DEFAULT '',
    user_id              text NOT NULL DEFAULT '',
    repo                 text NOT NULL DEFAULT '',
    branch               text NOT NULL DEFAULT '',
    committed_at         timestamptz NOT NULL,
    lines_total          bigint NOT NULL DEFAULT 0,
    lines_ai             bigint NOT NULL DEFAULT 0,
    ai_source            text NOT NULL DEFAULT '',
    ai_share_pct         double precision NOT NULL DEFAULT 0,
    is_production_branch boolean NOT NULL DEFAULT false,
    source_record_id     text NOT NULL DEFAULT '',
    ingested_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, commit_hash, identity_email)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'coding_commit_attribution' AND policyname = 'tenant_isolation'
    ) THEN
        ALTER TABLE coding_commit_attribution ENABLE ROW LEVEL SECURITY;
        ALTER TABLE coding_commit_attribution FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON coding_commit_attribution
            USING (tenant_id = app_current_tenant()::text)
            WITH CHECK (tenant_id = app_current_tenant()::text);
        GRANT SELECT, INSERT, UPDATE, DELETE ON coding_commit_attribution TO agentledger_api;
    END IF;
EXCEPTION
    WHEN undefined_function THEN
        RAISE NOTICE 'app_current_tenant() missing — apply migration 002_rls.sql first';
END
$$;
