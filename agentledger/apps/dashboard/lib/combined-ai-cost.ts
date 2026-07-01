/** Rows from /v1/fixed-costs/total-cost-of-ai (fixed slice is authoritative). */
export type FixedCostSliceRow = {
  fixed_cost_usd: number | string;
};

export type AiCostBreakdown = {
  attributable: number;
  fixed: number;
  total: number;
};

/** Sum fixed overhead across monthly rows in the selected range. */
export function sumFixedOverhead(rows: FixedCostSliceRow[]): number {
  return rows.reduce((s, r) => s + Number(r.fixed_cost_usd), 0);
}

/**
 * Total cost of AI = all metered spend (gateway + connectors) + fixed overhead.
 * Do not use v_total_cost_of_ai.total for the headline — that view's metered side
 * is gateway-only and undercounts vs analytics/spend.
 */
export function combinedAiCost(meteredUsd: number, fixedRows: FixedCostSliceRow[]): AiCostBreakdown {
  const fixed = sumFixedOverhead(fixedRows);
  return {
    attributable: meteredUsd,
    fixed,
    total: meteredUsd + fixed,
  };
}
