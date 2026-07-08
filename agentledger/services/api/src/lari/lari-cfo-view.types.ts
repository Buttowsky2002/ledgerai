/** Tenant-level CFO view response — aggregates v_roi + supplemental LARI costs. */
export type CostBasisMode = 'computed' | 'metered' | 'reconciled';

export interface CostStackBreakdown {
  /** Token/API usage (reconciled/computed/metered per costBasis). */
  tokenUsageUsd: number;
  tokenComputedUsd: number;
  tokenMeteredUsd: number;
  /** Fixed / seat license overhead from fixed_costs (not metered per token). */
  fixedCostUsd: number;
  codingAgentUsd: number;
  copilotUsd: number;
  /** QA, eval, integration, platform overhead on outcome-linked runs. */
  qaEvalOverheadUsd: number;
}

export interface CostProvenance {
  computedCostUsd: number;
  meteredCostUsd: number;
  effectiveCostUsd: number;
  variancePct: number;
  meteredCoveragePct: number;
  stack: CostStackBreakdown;
}

export interface CfoViewSummary {
  riskAdjustedRoi: number;
  nominalRoi: number;
  businessValue: number;
  /** Projected fully-loaded spend for the forecast horizon. */
  fullyLoadedCost: number;
  /** Observed fully-loaded spend over the selected date window (before projection). */
  observedFullyLoadedCost: number;
  forecastPerMonth: number;
  roiMargin: number;
  runRateMonths: number;
  /** Null when no attributed outcomes meet the confidence threshold. */
  costPerOutcome: number | null;
  /** Proxy CPO when outcomeCount is zero — uses API calls, tokens, or Copilot activity. */
  costPerOutcomeFallback: number | null;
  costPerOutcomeFallbackLabel: string | null;
  costPerOutcomeFallbackBasis: string | null;
  costBasis: CostBasisMode;
  forecastDays: number;
  observedPeriodDays: number;
}

export interface CfoViewMonthly {
  month: string;
  riskAdjustedRoi: number;
  nominalRoi: number;
  businessValue: number;
  fullyLoadedCost: number;
}

export interface CfoViewOutcomeBreakdown {
  outcomeType: string;
  outcomes: number;
  businessValue: number;
  fullyLoadedCost: number;
  nominalRoi: number;
  riskAdjustedRoi: number;
  avgConfidence: number;
  costPerOutcome: number;
}

export interface CfoViewProviderBreakdown {
  provider: string;
  costUsd: number;
  calls: number;
}

/** Per-model token economics from collected usage (spend_daily + cost basis). */
export interface CfoViewModelBreakdown {
  provider: string;
  model: string;
  /** Projected cost for the forecast horizon. */
  costUsd: number;
  /** Observed cost over the run-rate window. */
  observedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Blended $/1M tokens from actual collected usage and cost basis. */
  costPer1MTokens: number;
  /** $/token (observed, from usage). */
  costPerToken: number;
  calls: number;
}

export interface CfoViewResponse {
  from: string;
  to: string;
  confidenceThreshold: number;
  summary: CfoViewSummary;
  monthly: CfoViewMonthly[];
  outcomeBreakdown: CfoViewOutcomeBreakdown[];
  modelBreakdown: CfoViewModelBreakdown[];
  providerBreakdown: CfoViewProviderBreakdown[];
  costProvenance: CostProvenance;
  warnings: string[];
}
