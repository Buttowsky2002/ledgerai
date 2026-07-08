-- BadgerIQ Postgres migration 025 — v_cost_basis_daily (MVP analytics parity)
--
-- Mirrors deploy/clickhouse/018_cost_basis.sql for BADGERIQ_ANALYTICS_BACKEND=postgres.
-- Forward-only; never edit an applied migration.

CREATE OR REPLACE VIEW v_cost_basis_daily WITH (security_invoker = true) AS
WITH computed AS (
    SELECT tenant_id, day, provider, model,
           sum(cost_usd) AS computed_cost_usd,
           sum(calls)    AS calls,
           sum(input_tokens) + sum(output_tokens) AS tokens
    FROM spend_daily
    GROUP BY tenant_id, day, provider, model
),
metered AS (
    SELECT tenant_id, day, provider, model,
           sum(cost_usd) AS metered_cost_usd
    FROM provider_costs
    GROUP BY tenant_id, day, provider, model
)
SELECT
    coalesce(c.tenant_id, m.tenant_id) AS tenant_id,
    coalesce(c.day, m.day)             AS day,
    coalesce(c.provider, m.provider)   AS provider,
    coalesce(c.model, m.model)         AS model,
    coalesce(c.computed_cost_usd, 0)   AS computed_cost_usd,
    coalesce(m.metered_cost_usd, 0)    AS metered_cost_usd,
    CASE WHEN coalesce(m.metered_cost_usd, 0) > 0
         THEN m.metered_cost_usd
         ELSE coalesce(c.computed_cost_usd, 0)
    END                                AS effective_cost_usd,
    CASE WHEN coalesce(m.metered_cost_usd, 0) > 0 THEN 'metered' ELSE 'computed' END AS basis,
    coalesce(c.calls, 0)  AS calls,
    coalesce(c.tokens, 0) AS tokens
FROM computed c
FULL OUTER JOIN metered m
  ON c.tenant_id = m.tenant_id AND c.day = m.day
 AND c.provider = m.provider AND c.model = m.model;

GRANT SELECT ON v_cost_basis_daily TO agentledger_api;
