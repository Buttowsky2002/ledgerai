/**
 * FinOps metered spend — what counts in headline totals, user spend, and allocation.
 * Provider-reported / invoice-grade costs only; excludes price-book estimates and
 * subscription-included usage value (e.g. Cursor Included rows).
 */

export const NON_METERED_COST_SOURCES = ['pricebook_estimate', 'cursor_usage_value'] as const;

/** Providers whose spend is sourced from Postgres, not llm_calls aggregates. */
export const POSTGRES_METERED_PROVIDERS = ['github_copilot'] as const;

/** ClickHouse scope: exclude Postgres-sourced providers from llm_calls rollups. */
export const LLM_CALLS_METERED_SCOPE = `provider NOT IN ('github_copilot')`;

/**
 * Effective metered USD for one llm_calls row (handles legacy rows before metered_cost_usd backfill).
 * Embed as sum(...) in analytics queries — never interpolate user input.
 *
 * Column references are table-qualified (`llm_calls.cost_usd`) because queries alias
 * their aggregate output `AS cost_usd`; an unqualified reference would resolve to that
 * alias (ClickHouse prefers aliases over columns), nesting the aggregate → error 184.
 */
export const EFFECTIVE_METERED_COST_USD = `if(
  llm_calls.metered_cost_usd > 0,
  llm_calls.metered_cost_usd,
  if(
    llm_calls.provider = 'github_copilot',
    0,
    if(
      llm_calls.provider = 'cursor',
      if(llm_calls.operation_name = 'cursor:on_demand', llm_calls.cost_usd, 0),
      if(
        llm_calls.cost_source IN ('pricebook_estimate', 'cursor_usage_value'),
        0,
        llm_calls.cost_usd
      )
    )
  )
)`;

/**
 * Reconciled per-user spend: portal CSV billing wins over connector API sync
 * for the same user+day so billing imports do not double-count API rows.
 */
export const RECONCILED_USER_DAY_SPEND_SQL = `
  SELECT
    key,
    sum((CASE WHEN portal_usd > 0 THEN portal_usd ELSE api_usd END) + other_usd) AS cost_usd,
    sum((CASE WHEN portal_calls > 0 THEN portal_calls ELSE api_calls END) + other_calls) AS calls,
    sum(portal_usd) AS portal_import_usd,
    sum(api_usd) AS connector_usd
  FROM (
    SELECT
      if(user_id = '', 'Unassigned', user_id) AS key,
      toDate(ts) AS day,
      sumIf(${EFFECTIVE_METERED_COST_USD}, llm_calls.source = 'portal_import') AS portal_usd,
      sumIf(${EFFECTIVE_METERED_COST_USD}, llm_calls.source = 'api') AS api_usd,
      sumIf(
        ${EFFECTIVE_METERED_COST_USD},
        llm_calls.source NOT IN ('portal_import', 'api')
      ) AS other_usd,
      countIf(${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source = 'portal_import') AS portal_calls,
      countIf(${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source = 'api') AS api_calls,
      countIf(
        ${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source NOT IN ('portal_import', 'api')
      ) AS other_calls
    FROM llm_calls
    WHERE tenant_id = {tenant:String}
      AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
      AND ${LLM_CALLS_METERED_SCOPE}
    GROUP BY key, day
  ) AS per_day
  GROUP BY key
`;

/** Daily reconciled spend per user (for trend charts). */
export const RECONCILED_USER_DAILY_SPEND_SQL = `
  SELECT key AS user_id, day,
         sum((CASE WHEN portal_usd > 0 THEN portal_usd ELSE api_usd END) + other_usd) AS cost_usd,
         sum((CASE WHEN portal_calls > 0 THEN portal_calls ELSE api_calls END) + other_calls) AS calls
  FROM (
    SELECT
      if(user_id = '', 'Unassigned', user_id) AS key,
      toDate(ts) AS day,
      sumIf(${EFFECTIVE_METERED_COST_USD}, llm_calls.source = 'portal_import') AS portal_usd,
      sumIf(${EFFECTIVE_METERED_COST_USD}, llm_calls.source = 'api') AS api_usd,
      sumIf(
        ${EFFECTIVE_METERED_COST_USD},
        llm_calls.source NOT IN ('portal_import', 'api')
      ) AS other_usd,
      countIf(${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source = 'portal_import') AS portal_calls,
      countIf(${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source = 'api') AS api_calls,
      countIf(
        ${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source NOT IN ('portal_import', 'api')
      ) AS other_calls
    FROM llm_calls
    WHERE tenant_id = {tenant:String}
      AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
      AND ${LLM_CALLS_METERED_SCOPE}
    GROUP BY key, day
  ) AS per_day
  GROUP BY key, day
  ORDER BY key, day
`;

/**
 * Reconciled per-user model breakdown: portal CSV wins over connector API per
 * user+day+provider+model (same rule as RECONCILED_USER_DAY_SPEND_SQL).
 */
export const RECONCILED_USER_MODEL_BREAKDOWN_SQL = `
  SELECT
    key AS user_id,
    provider AS platform,
    model,
    sum(reconciled_usd) AS spend_usd,
    sum(reconciled_calls) AS calls,
    sum(portal_usd) AS portal_import_usd,
    sum(api_usd) AS connector_usd
  FROM (
    SELECT
      if(user_id = '', 'Unassigned', user_id) AS key,
      toDate(ts) AS day,
      provider,
      if(response_model != '', response_model, request_model) AS model,
      sumIf(${EFFECTIVE_METERED_COST_USD}, llm_calls.source = 'portal_import') AS portal_usd,
      sumIf(${EFFECTIVE_METERED_COST_USD}, llm_calls.source = 'api') AS api_usd,
      sumIf(
        ${EFFECTIVE_METERED_COST_USD},
        llm_calls.source NOT IN ('portal_import', 'api')
      ) AS other_usd,
      countIf(${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source = 'portal_import') AS portal_calls,
      countIf(${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source = 'api') AS api_calls,
      countIf(
        ${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source NOT IN ('portal_import', 'api')
      ) AS other_calls,
      (CASE WHEN portal_usd > 0 THEN portal_usd ELSE api_usd END) + other_usd AS reconciled_usd,
      (CASE WHEN portal_calls > 0 THEN portal_calls ELSE api_calls END) + other_calls AS reconciled_calls
    FROM llm_calls
    WHERE tenant_id = {tenant:String}
      AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
      AND ${LLM_CALLS_METERED_SCOPE}
    GROUP BY key, day, provider, model
  ) AS per_day_model
  GROUP BY key, provider, model
  HAVING sum(reconciled_calls) > 0
`;

/** Spend with no user_id on metered llm_calls rows (reconciled per-user-day rollup). */
export const RECONCILED_UNMAPPED_SPEND_SQL = `
  SELECT sum(cost_usd) AS unmapped_cost
  FROM (${RECONCILED_USER_DAY_SPEND_SQL}) AS reconciled
  WHERE key = 'Unassigned'
`;

/** Tenant daily spend — sum of reconciled per-user days (portal wins over API per user+day). */
export const RECONCILED_TENANT_DAILY_SPEND_SQL = `
  SELECT day, sum(cost_usd) AS cost_usd
  FROM (${RECONCILED_USER_DAILY_SPEND_SQL}) AS reconciled
  GROUP BY day
  ORDER BY day
`;

/** Provider spend — reconciled metered totals aggregated from per-user model breakdown. */
export const RECONCILED_PROVIDER_SPEND_SQL = `
  SELECT platform AS provider, sum(spend_usd) AS cost_usd, sum(calls) AS calls
  FROM (${RECONCILED_USER_MODEL_BREAKDOWN_SQL}) AS reconciled
  GROUP BY platform
  ORDER BY cost_usd DESC
`;

/**
 * Model usage for LARI — reconciled metered cost + tokens per provider/model
 * (portal CSV wins over connector API per user+day+provider+model).
 */
export const RECONCILED_MODEL_USAGE_SQL = `
  SELECT
    provider,
    model,
    sum(reconciled_input_tokens) AS input_tokens,
    sum(reconciled_output_tokens) AS output_tokens,
    sum(reconciled_usd) AS cost_usd,
    sum(reconciled_calls) AS calls
  FROM (
    SELECT
      if(user_id = '', 'Unassigned', user_id) AS key,
      toDate(ts) AS day,
      provider,
      if(response_model != '', response_model, request_model) AS model,
      sumIf(input_tokens, llm_calls.source = 'portal_import') AS portal_in,
      sumIf(output_tokens, llm_calls.source = 'portal_import') AS portal_out,
      sumIf(${EFFECTIVE_METERED_COST_USD}, llm_calls.source = 'portal_import') AS portal_usd,
      countIf(${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source = 'portal_import') AS portal_calls,
      sumIf(input_tokens, llm_calls.source = 'api') AS api_in,
      sumIf(output_tokens, llm_calls.source = 'api') AS api_out,
      sumIf(${EFFECTIVE_METERED_COST_USD}, llm_calls.source = 'api') AS api_usd,
      countIf(${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source = 'api') AS api_calls,
      sumIf(input_tokens, llm_calls.source NOT IN ('portal_import', 'api')) AS other_in,
      sumIf(output_tokens, llm_calls.source NOT IN ('portal_import', 'api')) AS other_out,
      sumIf(
        ${EFFECTIVE_METERED_COST_USD},
        llm_calls.source NOT IN ('portal_import', 'api')
      ) AS other_usd,
      countIf(
        ${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source NOT IN ('portal_import', 'api')
      ) AS other_calls,
      (CASE WHEN portal_usd > 0 THEN portal_in ELSE api_in END) + other_in AS reconciled_input_tokens,
      (CASE WHEN portal_usd > 0 THEN portal_out ELSE api_out END) + other_out AS reconciled_output_tokens,
      (CASE WHEN portal_usd > 0 THEN portal_usd ELSE api_usd END) + other_usd AS reconciled_usd,
      (CASE WHEN portal_calls > 0 THEN portal_calls ELSE api_calls END) + other_calls AS reconciled_calls
    FROM llm_calls
    WHERE tenant_id = {tenant:String}
      AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
      AND ${LLM_CALLS_METERED_SCOPE}
    GROUP BY key, day, provider, model
  ) AS per_day_model
  GROUP BY provider, model
  HAVING sum(reconciled_calls) > 0
  ORDER BY cost_usd DESC
`;

/** Tenant-level reconciled cost basis totals (deduped llm_calls — not spend_daily MV). */
export const RECONCILED_COST_BASIS_TOTALS_SQL = `
  SELECT
    sum(reconciled_usd) AS effective_cost_usd,
    sum(reconciled_usd) AS metered_cost_usd,
    sum(reconciled_usd) AS computed_cost_usd,
    sum(reconciled_calls) AS calls,
    count() AS total_keys,
    countIf(reconciled_usd > 0) AS metered_keys
  FROM (
    SELECT
      if(user_id = '', 'Unassigned', user_id) AS key,
      toDate(ts) AS day,
      provider,
      if(response_model != '', response_model, request_model) AS model,
      sumIf(${EFFECTIVE_METERED_COST_USD}, llm_calls.source = 'portal_import') AS portal_usd,
      sumIf(${EFFECTIVE_METERED_COST_USD}, llm_calls.source = 'api') AS api_usd,
      sumIf(
        ${EFFECTIVE_METERED_COST_USD},
        llm_calls.source NOT IN ('portal_import', 'api')
      ) AS other_usd,
      countIf(${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source = 'portal_import') AS portal_calls,
      countIf(${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source = 'api') AS api_calls,
      countIf(
        ${EFFECTIVE_METERED_COST_USD} > 0 AND llm_calls.source NOT IN ('portal_import', 'api')
      ) AS other_calls,
      (CASE WHEN portal_usd > 0 THEN portal_usd ELSE api_usd END) + other_usd AS reconciled_usd,
      (CASE WHEN portal_calls > 0 THEN portal_calls ELSE api_calls END) + other_calls AS reconciled_calls
    FROM llm_calls
    WHERE tenant_id = {tenant:String}
      AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
      AND ${LLM_CALLS_METERED_SCOPE}
    GROUP BY key, day, provider, model
  ) AS per_day_model
`;

/** Monthly reconciled metered spend for CFO monthly chart. */
export const RECONCILED_COST_BASIS_MONTHLY_SQL = `
  SELECT
    toStartOfMonth(day) AS month,
    sum(reconciled_usd) AS effective_cost_usd,
    sum(reconciled_usd) AS metered_cost_usd,
    sum(reconciled_usd) AS computed_cost_usd
  FROM (
    SELECT
      if(user_id = '', 'Unassigned', user_id) AS key,
      toDate(ts) AS day,
      provider,
      if(response_model != '', response_model, request_model) AS model,
      sumIf(${EFFECTIVE_METERED_COST_USD}, llm_calls.source = 'portal_import') AS portal_usd,
      sumIf(${EFFECTIVE_METERED_COST_USD}, llm_calls.source = 'api') AS api_usd,
      sumIf(
        ${EFFECTIVE_METERED_COST_USD},
        llm_calls.source NOT IN ('portal_import', 'api')
      ) AS other_usd,
      (CASE WHEN portal_usd > 0 THEN portal_usd ELSE api_usd END) + other_usd AS reconciled_usd
    FROM llm_calls
    WHERE tenant_id = {tenant:String}
      AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
      AND ${LLM_CALLS_METERED_SCOPE}
    GROUP BY key, day, provider, model
  ) AS per_day_model
  GROUP BY month
  ORDER BY month
`;

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function isNonMeteredCostSource(costSource: string | undefined): boolean {
  const s = String(costSource ?? '').trim();
  return (NON_METERED_COST_SOURCES as readonly string[]).includes(s);
}

/** Compute billable metered USD stamped on connector/gateway import rows. */
export function computeMeteredCostUsd(metrics: Record<string, unknown>): number {
  const costSource = String(metrics.cost_source ?? '').trim();
  if (isNonMeteredCostSource(costSource)) return 0;

  const operationName = String(metrics.operation_name ?? '');
  if (operationName === 'cursor:included' || operationName === 'cursor:errored') return 0;
  if (operationName === 'cursor:on_demand') return round6(num(metrics.cost_usd));

  const provider = String(metrics.provider ?? '').toLowerCase();
  if ((POSTGRES_METERED_PROVIDERS as readonly string[]).includes(provider)) return 0;

  if (provider === 'cursor') {
    const kind = String(metrics.billing_kind ?? metrics.product ?? '').toLowerCase();
    if (kind.includes('included') || kind.includes('error')) return 0;
    if (kind.includes('on-demand') || kind.includes('usage-based')) return round6(num(metrics.cost_usd));
    if (!operationName.startsWith('cursor:')) return 0;
  }

  return round6(num(metrics.cost_usd));
}
