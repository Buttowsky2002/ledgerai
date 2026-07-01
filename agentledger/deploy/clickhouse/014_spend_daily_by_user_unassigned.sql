-- Include unassigned API spend in user-level allocation aggregates.

DROP VIEW IF EXISTS agentledger.mv_spend_daily_by_user;

CREATE MATERIALIZED VIEW IF NOT EXISTS agentledger.mv_spend_daily_by_user
TO agentledger.spend_daily_by_user AS
SELECT
    toDate(ts)                                   AS day,
    tenant_id,
    if(user_id = '', 'Unassigned', user_id)      AS user_id,
    provider,
    if(response_model != '', response_model, request_model) AS model,
    count()                                      AS calls,
    sum(cost_usd)                                AS cost_usd
FROM agentledger.llm_calls
GROUP BY day, tenant_id, user_id, provider, model;
