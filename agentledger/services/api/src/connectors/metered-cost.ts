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
