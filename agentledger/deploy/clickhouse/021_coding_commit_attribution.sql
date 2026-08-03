-- BadgerIQ ClickHouse migration 021 — coding_commit_attribution (Cursor Enterprise)
-- Per-commit AI line attribution from /analytics/ai-code/commits.
-- Forward-only; never edit an applied migration.

CREATE TABLE IF NOT EXISTS agentledger.coding_commit_attribution
(
    tenant_id             LowCardinality(String),
    source_tool           LowCardinality(String) DEFAULT 'cursor',
    commit_hash           String,
    identity_email        String DEFAULT '',
    user_id               String DEFAULT '',
    repo                  String DEFAULT '',
    branch                String DEFAULT '',
    committed_at          DateTime64(3) CODEC(Delta, ZSTD),
    lines_total           UInt32 DEFAULT 0,
    lines_ai              UInt32 DEFAULT 0,
    ai_source             LowCardinality(String) DEFAULT '',
    ai_share_pct          Float64 DEFAULT 0,
    is_production_branch  UInt8 DEFAULT 0,
    source_record_id      String DEFAULT '',
    ingested_at           DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(committed_at)
ORDER BY (tenant_id, committed_at, commit_hash, identity_email)
TTL toDateTime(committed_at) + INTERVAL 13 MONTH
SETTINGS index_granularity = 8192;
