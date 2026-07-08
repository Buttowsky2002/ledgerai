-- BadgerIQ ClickHouse migration 018 — unified cost basis per (tenant, day, provider, model)
--
-- computed = gateway/SDK price-book math (spend_daily); metered = provider-billed
-- imports (provider_costs, latest import wins). effective = metered when a
-- metered row exists for the key, else computed — FOCUS-style BilledCost vs
-- EffectiveCost duality. Read by /v1/lari/cfo-view.
--
-- Forward-only; never edit an applied migration.

CREATE VIEW IF NOT EXISTS agentledger.v_cost_basis_daily AS
WITH computed AS (
    SELECT tenant_id, day, provider, model,
           sum(cost_usd) AS computed_cost_usd,
           sum(calls)    AS calls,
           sum(input_tokens) + sum(output_tokens) AS tokens
    FROM agentledger.spend_daily
    GROUP BY tenant_id, day, provider, model
),
metered AS (
    SELECT tenant_id, day, provider, model,
           sum(cost_usd) AS metered_cost_usd
    FROM agentledger.provider_costs FINAL
    GROUP BY tenant_id, day, provider, model
)
SELECT
    coalesce(c.tenant_id, m.tenant_id) AS tenant_id,
    coalesce(c.day, m.day)             AS day,
    coalesce(c.provider, m.provider)   AS provider,
    coalesce(c.model, m.model)         AS model,
    coalesce(c.computed_cost_usd, 0)   AS computed_cost_usd,
    coalesce(m.metered_cost_usd, 0)    AS metered_cost_usd,
    if(m.metered_cost_usd > 0, m.metered_cost_usd, coalesce(c.computed_cost_usd, 0)) AS effective_cost_usd,
    if(m.metered_cost_usd > 0, 'metered', 'computed') AS basis,
    coalesce(c.calls, 0)  AS calls,
    coalesce(c.tokens, 0) AS tokens
FROM computed c
FULL OUTER JOIN metered m
  ON c.tenant_id = m.tenant_id AND c.day = m.day
 AND c.provider = m.provider AND c.model = m.model
SETTINGS join_use_nulls = 1;
