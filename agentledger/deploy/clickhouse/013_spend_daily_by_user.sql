-- Daily spend by user — powers allocation by user_id from connector imports.

CREATE TABLE IF NOT EXISTS agentledger.spend_daily_by_user
(
    day            Date,
    tenant_id      LowCardinality(String),
    user_id        String,
    provider       LowCardinality(String),
    model          LowCardinality(String),
    calls          UInt64,
    cost_usd       Float64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, day, user_id, provider, model);

CREATE MATERIALIZED VIEW IF NOT EXISTS agentledger.mv_spend_daily_by_user
TO agentledger.spend_daily_by_user AS
SELECT
    toDate(ts)                                   AS day,
    tenant_id,
    user_id,
    provider,
    if(response_model != '', response_model, request_model) AS model,
    count()                                      AS calls,
    sum(cost_usd)                                AS cost_usd
FROM agentledger.llm_calls
WHERE user_id != ''
GROUP BY day, tenant_id, user_id, provider, model;
