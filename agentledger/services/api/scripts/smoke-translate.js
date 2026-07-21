/**
 * Smoke helper: translate representative ClickHouse-dialect analytics queries
 * with the compiled translator and print them with test values inlined, so
 * they can be piped into psql against a seeded Postgres to prove the
 * postgres analytics backend executes real dashboard queries.
 *
 * Test-only inlining: values here are hardcoded constants, never user input.
 */
'use strict';

const { translateChSql } = require('../dist/analytics-store/ch-sql-translator');
const { EFFECTIVE_METERED_COST_USD, LLM_CALLS_METERED_SCOPE } = require('../dist/connectors/metered-cost');

const params = { tenant: '00000000-0000-4000-8000-000000000001', from: '2026-06-01', to: '2026-07-06', minconf: 0.5 };

const queries = {
  spend: `SELECT toDate(ts) AS day,
       sum(${EFFECTIVE_METERED_COST_USD}) AS cost_usd,
       countIf(${EFFECTIVE_METERED_COST_USD} > 0) AS calls,
       sum(input_tokens + output_tokens) AS tokens,
       countIf(status LIKE 'blocked%') AS blocked_calls,
       countIf(status = 'upstream_error') AS error_calls
     FROM llm_calls
     WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
       AND ${LLM_CALLS_METERED_SCOPE}
     GROUP BY day ORDER BY day`,
  spend_daily_view: `SELECT day, provider, sum(cost_usd) AS cost_usd, sum(calls) AS calls
     FROM spend_daily WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
     GROUP BY day, provider ORDER BY day`,
  roi: `SELECT toStartOfMonth(outcome_ts) AS month, outcome_type,
       sum(value_usd) AS value_usd, sum(fully_loaded_cost_usd) AS cost_usd,
       sum(risk_adjusted_roi_usd) AS risk_adjusted_roi_usd,
       countIf(headline_eligible) AS eligible, avg(attribution_confidence) AS confidence
     FROM agentledger.v_roi
     WHERE tenant_id = {tenant:String} AND toDate(outcome_ts) BETWEEN {from:Date} AND {to:Date}
       AND attribution_confidence >= {minconf:Float32}
     GROUP BY month, outcome_type ORDER BY month`,
  risk: `SELECT e.agent_id AS agent_id, sum(e.occurrences) AS occurrences,
       countIf(e.severity = 'high') AS high_severity,
       argMax(e.detail, e.detected_at) AS latest_detail
     FROM agentledger.risk_events e FINAL
     WHERE e.tenant_id = {tenant:String}
     GROUP BY e.agent_id`,
  unit_econ: `SELECT day, cost_usd, outcomes_count, value_usd, net_value_usd
     FROM agentledger.v_agent_daily_unit_economics
     WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
     ORDER BY day`,
  total_cost: `SELECT month, attributable_cost_usd, fixed_cost_usd, total_cost_of_ai_usd
     FROM agentledger.v_total_cost_of_ai
     WHERE tenant_id = {tenant:String} AND month BETWEEN {from:Date} AND {to:Date} ORDER BY month`,
};

function inline(sql, values) {
  // $n → quoted literal, longest index first so $10 is not clobbered by $1.
  for (let i = values.length; i >= 1; i--) {
    const v = values[i - 1];
    const lit = typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
    sql = sql.split(`$${i}`).join(lit);
  }
  return sql;
}

for (const [name, q] of Object.entries(queries)) {
  const { sql, values } = translateChSql(q, params);
  process.stdout.write(`\\echo === ${name}\n${inline(sql, values)};\n`);
}
