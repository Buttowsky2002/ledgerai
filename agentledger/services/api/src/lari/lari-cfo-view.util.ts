import {
  CostBasisMode,
  CostProvenance,
  CfoViewMonthly,
  CfoViewOutcomeBreakdown,
  CfoViewModelBreakdown,
} from './lari-cfo-view.types';

// Pure CFO-view helpers extracted verbatim from LariCfoViewService so each
// transform is unit-testable in isolation and the service file carries only
// orchestration + ClickHouse/Prisma I/O. Nothing here touches `this`, the
// network, or the database — they only reshape already-fetched rows.

export type Range = { from: string; to: string };

export const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

export const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

export const pct = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

export interface RoiAggRow {
  month: string;
  outcome_type: string;
  outcomes: number;
  value_usd: number;
  ai_cost_usd: number;
  fully_loaded_cost_usd: number;
  nominal_roi_usd: number;
  risk_adjusted_roi_usd: number;
  avg_confidence: number;
}

export interface CostBasisTotals {
  computed_cost_usd: number;
  metered_cost_usd: number;
  effective_cost_usd: number;
  calls: number;
  total_keys: number;
  metered_keys: number;
}

export interface CostBasisMonthlyRow {
  month: string;
  computed_cost_usd: number;
  metered_cost_usd: number;
  effective_cost_usd: number;
}

export function normalizeCostBasis(costBasis?: string): CostBasisMode {
  if (costBasis === 'computed' || costBasis === 'metered' || costBasis === 'reconciled') {
    return costBasis;
  }

  return 'reconciled';
}

export function usageCostForBasis(basis: CostBasisMode, totals: CostBasisTotals): number {
  if (basis === 'computed') {
    return n(totals.computed_cost_usd);
  }

  if (basis === 'metered') {
    return n(totals.metered_cost_usd);
  }

  return n(totals.effective_cost_usd);
}

export function monthlyUsageForBasis(basis: CostBasisMode, row: CostBasisMonthlyRow): number {
  if (basis === 'computed') {
    return n(row.computed_cost_usd);
  }

  if (basis === 'metered') {
    return n(row.metered_cost_usd);
  }

  return n(row.effective_cost_usd);
}

export function buildCostProvenance(totals: CostBasisTotals): CostProvenance {
  const computed = n(totals.computed_cost_usd);

  const metered = n(totals.metered_cost_usd);

  const effective = n(totals.effective_cost_usd);

  const totalKeys = n(totals.total_keys);

  const meteredKeys = n(totals.metered_keys);

  const variancePct = computed > 0 ? ((metered - computed) / computed) * 100 : 0;

  const meteredCoveragePct = totalKeys > 0 ? (meteredKeys / totalKeys) * 100 : 0;

  return {
    computedCostUsd: usd(computed),

    meteredCostUsd: usd(metered),

    effectiveCostUsd: usd(effective),

    variancePct: pct(variancePct),

    meteredCoveragePct: pct(meteredCoveragePct),

    stack: {
      tokenUsageUsd: 0,
      tokenComputedUsd: usd(computed),
      tokenMeteredUsd: usd(metered),
      fixedCostUsd: 0,
      codingAgentUsd: 0,
      copilotUsd: 0,
      qaEvalOverheadUsd: 0,
    },
  };
}

export function range(from: string | undefined, to: string | undefined, days = 365): Range {
  const today = new Date();

  const start = new Date(today);

  start.setUTCDate(start.getUTCDate() - days);

  const iso = (d: Date) => d.toISOString().slice(0, 10);

  return { from: from ?? iso(start), to: to ?? iso(today) };
}

export function buildModelBreakdown(
  usageRows: Array<{
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    calls: number;
    computed_cost_usd: number;
  }>,
  basisRows: Array<{
    provider: string;
    model: string;
    computed_cost_usd: number;
    metered_cost_usd: number;
    effective_cost_usd: number;
  }>,
  basis: CostBasisMode,
  variableScale: number,
): CfoViewModelBreakdown[] {
  const basisByKey = new Map(
    basisRows.map((r) => [
      `${String(r.provider)}::${String(r.model)}`,
      {
        computed: n(r.computed_cost_usd),
        metered: n(r.metered_cost_usd),
        effective: n(r.effective_cost_usd),
      },
    ]),
  );

  return usageRows
    .map((row) => {
      const key = `${String(row.provider)}::${String(row.model)}`;
      const b = basisByKey.get(key);
      const computed = b?.computed ?? n(row.computed_cost_usd);
      const observedCost =
        basis === 'computed'
          ? computed
          : basis === 'metered'
            ? (b?.metered ?? 0)
            : (b?.effective ?? computed);
      const inputTokens = n(row.input_tokens);
      const outputTokens = n(row.output_tokens);
      const totalTokens = inputTokens + outputTokens;
      const costPerToken = totalTokens > 0 ? observedCost / totalTokens : 0;
      const costPer1M = costPerToken * 1_000_000;
      const projectedCost = observedCost * variableScale;

      return {
        provider: String(row.provider),
        model: String(row.model),
        costUsd: usd(projectedCost),
        observedCostUsd: usd(observedCost),
        inputTokens,
        outputTokens,
        totalTokens,
        costPer1MTokens: usd(costPer1M),
        costPerToken: Math.round(costPerToken * 1e8) / 1e8,
        calls: n(row.calls),
      };
    })
    .filter((r) => r.observedCostUsd > 0 || r.totalTokens > 0)
    .sort((a, b) => b.observedCostUsd - a.observedCostUsd);
}

export function computeCostPerOutcomeFallback(
  fullyLoadedCost: number,
  apiCalls: number,
  totalTokens: number,
  copilotCalls: number,
): {
  costPerOutcomeFallback: number | null;
  costPerOutcomeFallbackLabel: string | null;
  costPerOutcomeFallbackBasis: string | null;
} {
  if (fullyLoadedCost <= 0) {
    return {
      costPerOutcomeFallback: null,
      costPerOutcomeFallbackLabel: null,
      costPerOutcomeFallbackBasis: null,
    };
  }
  if (apiCalls > 0) {
    return {
      costPerOutcomeFallback: usd(fullyLoadedCost / apiCalls),
      costPerOutcomeFallbackLabel: 'per model call',
      costPerOutcomeFallbackBasis: `${apiCalls.toLocaleString('en-US')} API/model calls — proxy until outcomes are linked`,
    };
  }
  if (totalTokens > 0) {
    const tokenMillions = totalTokens / 1_000_000;
    return {
      costPerOutcomeFallback: usd(fullyLoadedCost / tokenMillions),
      costPerOutcomeFallbackLabel: 'per 1M tokens',
      costPerOutcomeFallbackBasis: `${tokenMillions.toFixed(2)}M tokens processed — proxy until outcomes are linked`,
    };
  }
  if (copilotCalls > 0) {
    return {
      costPerOutcomeFallback: usd(fullyLoadedCost / copilotCalls),
      costPerOutcomeFallbackLabel: 'per Copilot interaction',
      costPerOutcomeFallbackBasis: `${copilotCalls.toLocaleString('en-US')} Copilot acceptances, chat turns, and PR summaries — proxy until outcomes are linked`,
    };
  }
  return {
    costPerOutcomeFallback: null,
    costPerOutcomeFallbackLabel: null,
    costPerOutcomeFallbackBasis: null,
  };
}

export function buildMonthly(
  rows: RoiAggRow[],
  costBasisMonthly: CostBasisMonthlyRow[],
  supplementalCost: number,
  basis: CostBasisMode,
): CfoViewMonthly[] {
  const byMonth = new Map<string, RoiAggRow>();

  for (const row of rows) {
    const m = String(row.month).slice(0, 7);

    const prev = byMonth.get(m);

    if (prev) {
      prev.outcomes = n(prev.outcomes) + n(row.outcomes);

      prev.value_usd = n(prev.value_usd) + n(row.value_usd);

      prev.ai_cost_usd = n(prev.ai_cost_usd) + n(row.ai_cost_usd);

      prev.fully_loaded_cost_usd = n(prev.fully_loaded_cost_usd) + n(row.fully_loaded_cost_usd);

      prev.nominal_roi_usd = n(prev.nominal_roi_usd) + n(row.nominal_roi_usd);

      prev.risk_adjusted_roi_usd = n(prev.risk_adjusted_roi_usd) + n(row.risk_adjusted_roi_usd);
    } else {
      byMonth.set(m, { ...row, month: m });
    }
  }

  for (const spend of costBasisMonthly) {
    const m = String(spend.month).slice(0, 7);

    if (!byMonth.has(m)) {
      byMonth.set(m, {
        month: m,

        outcome_type: '',

        outcomes: 0,

        value_usd: 0,

        ai_cost_usd: 0,

        fully_loaded_cost_usd: 0,

        nominal_roi_usd: 0,

        risk_adjusted_roi_usd: 0,

        avg_confidence: 0,
      });
    }
  }

  const months = [...byMonth.keys()].sort();

  const perMonthSupplement = months.length > 0 ? supplementalCost / months.length : 0;

  return months.map((month) => {
    const row = byMonth.get(month)!;

    const spendRow = costBasisMonthly.find((s) => String(s.month).slice(0, 7) === month);

    const monthUsage = spendRow ? monthlyUsageForBasis(basis, spendRow) : 0;

    const monthOutcomeLoaded = n(row.fully_loaded_cost_usd);

    const monthOutcomeAi = n(row.ai_cost_usd);

    const monthNonToken = Math.max(0, monthOutcomeLoaded - monthOutcomeAi);

    const monthFullyLoaded = monthUsage + perMonthSupplement + monthNonToken;

    const monthRiskAdjValue = n(row.risk_adjusted_roi_usd) + monthOutcomeLoaded;

    return {
      month,

      businessValue: usd(n(row.value_usd)),

      fullyLoadedCost: usd(monthFullyLoaded),

      nominalRoi: usd(n(row.value_usd) - monthFullyLoaded),

      riskAdjustedRoi: usd(monthRiskAdjValue - monthFullyLoaded),
    };
  });
}

export function buildOutcomeBreakdown(
  rows: RoiAggRow[],
  ctx: {
    usageCost: number;
    supplementalCost: number;
    outcomeAiCost: number;
    outcomeCount: number;
  },
): CfoViewOutcomeBreakdown[] {
  const byType = new Map<string, RoiAggRow>();

  for (const row of rows) {
    const t = String(row.outcome_type);

    const prev = byType.get(t);

    if (prev) {
      prev.outcomes = n(prev.outcomes) + n(row.outcomes);

      prev.value_usd = n(prev.value_usd) + n(row.value_usd);

      prev.ai_cost_usd = n(prev.ai_cost_usd) + n(row.ai_cost_usd);

      prev.fully_loaded_cost_usd = n(prev.fully_loaded_cost_usd) + n(row.fully_loaded_cost_usd);

      prev.nominal_roi_usd = n(prev.nominal_roi_usd) + n(row.nominal_roi_usd);

      prev.risk_adjusted_roi_usd = n(prev.risk_adjusted_roi_usd) + n(row.risk_adjusted_roi_usd);

      prev.avg_confidence = (n(prev.avg_confidence) + n(row.avg_confidence)) / 2;
    } else {
      byType.set(t, { ...row });
    }
  }

  const sharedPool = ctx.usageCost + ctx.supplementalCost;

  return [...byType.entries()]

    .map(([outcomeType, row]) => {
      const outcomes = n(row.outcomes);

      const typeAi = n(row.ai_cost_usd);

      const typeLoaded = n(row.fully_loaded_cost_usd);

      const weight =
        ctx.outcomeAiCost > 0
          ? typeAi / ctx.outcomeAiCost
          : ctx.outcomeCount > 0
            ? outcomes / ctx.outcomeCount
            : 0;

      const allocatedShared = sharedPool * weight;

      const typeOverhead = Math.max(0, typeLoaded - typeAi);

      const fullyLoaded = allocatedShared + typeOverhead;

      return {
        outcomeType,

        outcomes,

        businessValue: usd(n(row.value_usd)),

        fullyLoadedCost: usd(fullyLoaded),

        nominalRoi: usd(n(row.nominal_roi_usd)),

        riskAdjustedRoi: usd(n(row.risk_adjusted_roi_usd)),

        avgConfidence: Math.round(n(row.avg_confidence) * 100) / 100,

        costPerOutcome: usd(outcomes > 0 ? fullyLoaded / outcomes : 0),
      };
    })

    .sort((a, b) => b.riskAdjustedRoi - a.riskAdjustedRoi);
}

export function buildWarnings(ctx: {
  fullyLoadedCost: number;

  usageCost: number;

  businessValue: number;

  outcomeCount: number;

  totalOutcomesAll: number;

  minconf: number;

  unmappedCost: number;

  seatStats: { purchased: number; active: number };

  supplementalCost: number;

  copilotValue: number;

  cursorProductivityValue: number;

  costBasis: CostBasisMode;

  costProvenance: CostProvenance;
}): string[] {
  const w: string[] = [];

  if (ctx.copilotValue > 0) {
    w.push(
      'Business value includes estimated GitHub Copilot productivity value — not exact measures from GitHub.',
    );
  }

  if (ctx.cursorProductivityValue > 0) {
    w.push(
      'Business value includes estimated Cursor productivity (accepted AI lines, tabs, composer/chat) from daily usage sync — not git commit revenue.',
    );
  }

  if (Math.abs(ctx.costProvenance.variancePct) > 2) {
    w.push(
      `Computed vs metered cost variance is ${ctx.costProvenance.variancePct.toFixed(1)}% — review provider billing imports.`,
    );
  }

  if (ctx.costBasis === 'metered' && ctx.costProvenance.meteredCoveragePct < 50) {
    w.push(
      `Metered cost basis selected but only ${ctx.costProvenance.meteredCoveragePct.toFixed(0)}% of provider/model keys have billed imports.`,
    );
  }

  if (ctx.fullyLoadedCost === 0 && ctx.usageCost > 0) {
    w.push(
      'Fully-loaded cost is $0 but API usage exists — check outcome linkage and ROI templates.',
    );
  }

  if (ctx.businessValue === 0 && ctx.totalOutcomesAll > 0) {
    w.push(
      'Business value is $0 but outcomes exist — configure ROI templates or set business_value_usd.',
    );
  }

  if (ctx.outcomeCount === 0 && ctx.totalOutcomesAll > 0 && ctx.minconf > 0) {
    w.push(`Confidence threshold ≥ ${ctx.minconf} removes all outcomes from headline metrics.`);
  }

  if (ctx.unmappedCost > 0) {
    w.push(
      `$${ctx.unmappedCost.toFixed(2)} in provider spend has no user assignment — open Settings → Connectors, expand your connector, and add a provider-user mapping if needed.`,
    );
  }

  if (ctx.seatStats.purchased > 0 && ctx.seatStats.active === 0) {
    w.push('Subscription seats are paid but no active seat assignments detected.');
  }

  if (ctx.usageCost > 0 && ctx.outcomeCount === 0) {
    w.push('Agent runs / usage exist but no outcomes are linked above the confidence threshold.');
  }

  if (ctx.supplementalCost > 0 && ctx.outcomeCount === 0) {
    w.push(
      'Subscription or coding-agent costs are allocated but no attributed outcomes in period.',
    );
  }

  return w;
}
