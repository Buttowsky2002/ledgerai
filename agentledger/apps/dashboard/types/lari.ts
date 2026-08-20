/** Tenant-level CFO view response — mirrors GET /v1/lari/cfo-view. */
export type CostBasisMode = 'computed' | 'metered' | 'reconciled';

export interface CostStackBreakdown {
  tokenUsageUsd: number;
  tokenComputedUsd: number;
  tokenMeteredUsd: number;
  fixedCostUsd: number;
  codingAgentUsd: number;
  copilotUsd: number;
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
  fullyLoadedCost: number;
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

export interface CfoViewModelBreakdown {
  provider: string;
  model: string;
  costUsd: number;
  observedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costPer1MTokens: number;
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

/** LARI actionable recommendations — mirrors GET /v1/lari/recommendations. */
export type RecommendationPriority = 'low' | 'medium' | 'high' | 'critical';

export type SavingsCategory =
  | 'seat_optimization'
  | 'plan_optimization'
  | 'provider_value'
  | 'agent_economics'
  | 'attribution'
  | 'configuration'
  | 'model_substitution'
  | 'user_value'
  | 'product_worth'
  | 'budget_suggestion'
  | 'spend_driver';

export interface LariActionableRecommendation {
  id: string;
  priority: RecommendationPriority;
  category: SavingsCategory;
  title: string;
  message: string;
  action: string;
  estimatedSavingsUsd?: number;
  estimatedImpactUsd?: number;
  mlScore: number;
  evidence: string[];
  relatedEntity?: { type: 'agent' | 'provider' | 'plan' | 'user' | 'model'; id: string };
}

export interface ProviderValueRanking {
  provider: string;
  costUsd: number;
  calls: number;
  attributedValueUsd: number;
  valuePerDollar: number;
  efficiencyScore: number;
  rank: number;
}

export interface AgentEconomicsHighlight {
  agentId: string;
  costUsd: number;
  valueUsd: number;
  lari: number;
  confidenceScore: number;
  recommendation: string;
  topProvider?: string;
}

export interface LariRecommendationsResponse {
  from: string;
  to: string;
  recommendations: LariActionableRecommendation[];
  providerRankings: ProviderValueRanking[];
  agentEconomicsHighlights: AgentEconomicsHighlight[];
  summary: {
    totalEstimatedSavingsUsd: number;
    highPriorityCount: number;
    criticalCount: number;
  };
}

export type PerUserAnalyticsMode = 'individual' | 'team';

export type UserUtilizationStatus = 'active' | 'low_use' | 'inactive';

export interface UserUtilizationRow {
  userId: string;
  displayName: string;
  providers: string[];
  costUsd: number;
  calls: number;
  activeDays: number;
  codingAgentCostUsd: number;
  sessions: number;
  utilizationScore: number;
  seatMonthlyCostUsd: number;
  status: UserUtilizationStatus;
  hasSeat: boolean;
  planId?: string;
  planName?: string;
  seatProvider?: string;
}

export interface UserValueTeamAggregate {
  provisionedSeats: number;
  activeSeats: number;
  inactiveSeats: number;
  lowUseSeats: number;
  reclaimableMonthlyUsd: number;
  meteredUsers: number;
  activeMeteredUsers: number;
  lowUseMeteredUsers: number;
  inactiveMeteredUsers: number;
  meteredSpendUsd: number;
  byPlan: Array<{
    planId: string;
    planName: string;
    provider: string;
    inactiveCount: number;
    reclaimableMonthlyUsd: number;
  }>;
  byProvider: Array<{
    provider: string;
    inactiveCount: number;
    reclaimableMonthlyUsd: number;
  }>;
}

export interface UserValueTeamResponse {
  from: string;
  to: string;
  mode: 'team';
  aggregates: UserValueTeamAggregate;
}

export interface UserValueIndividualResponse {
  from: string;
  to: string;
  mode: 'individual';
  users: UserUtilizationRow[];
}

export type UserValueResponse = UserValueTeamResponse | UserValueIndividualResponse;

/** Product worth scorecard — mirrors GET /v1/lari/product-worth. */
export type ProductWorthVerdict = 'worth_it' | 'marginal' | 'not_worth_it' | 'insufficient_data';

export type ProductDataMode = 'import_only' | 'connector_only' | 'live_only' | 'mixed' | 'unknown';

export type SpendTrend = 'up' | 'down' | 'flat' | 'insufficient';

export interface ProductSpendBySource {
  portalImportUsd: number;
  connectorUsd: number;
  liveUsd: number;
  portalImportCalls: number;
  connectorCalls: number;
  liveCalls: number;
}

export type ProductConfidenceBasis =
  | 'outcomes'
  | 'utilization'
  | 'productivity_proxy'
  | 'mixed'
  | 'none';

export interface ProductSpendDriver {
  type: 'user' | 'model' | 'seat_waste';
  label: string;
  costUsd: number;
  detail?: string;
}

export interface ProductWorthEntry {
  product: string;
  totalSpendUsd: number;
  seatCostUsd: number;
  meteredSpendUsd: number;
  attributedValueUsd: number;
  worthRatio: number | null;
  verdict: ProductWorthVerdict;
  confidenceScore: number;
  confidenceBasis: ProductConfidenceBasis;
  monthlyRunRateUsd: number;
  recommendedBudgetUsd: number | null;
  topDrivers: ProductSpendDriver[];
  spendNarrative: string;
  spendTrend: SpendTrend;
  periodChangePct: number | null;
  periodChangeUsd: number | null;
  connectOutcomesPrompt: boolean;
  spendBySource?: ProductSpendBySource;
  dataMode?: ProductDataMode;
}

export interface DataCoverageSummary {
  totalSpendUsd: number;
  portalImportUsd: number;
  connectorUsd: number;
  liveUsd: number;
  portalImportSharePct: number;
  importOnlyProducts: number;
  productsWithoutOutcomes: number;
  totalOutcomes: number;
  importOutcomes: number;
  connectorOutcomes: number;
  roiLinkedOutcomes: number;
  roiLinkedValueUsd: number;
  roiCoveragePct: number;
  headlineEligibleOutcomes: number;
  portalImportRuns: number;
  bulkImportEvents: number;
  billingConnectors: string[];
  outcomeConnectors: string[];
  worthAnalysisReady: boolean;
  outcomeRoiReady: boolean;
}

export interface RecommendedOutcomeSource {
  id: string;
  label: string;
  outcomeType: string;
  href: string;
  reason: string;
}

export interface OutcomeSourceStatus {
  connected: string[];
  recommended: RecommendedOutcomeSource[];
}

export interface BudgetSuggestionEntry {
  scope: 'tenant' | 'product' | 'agent';
  scopeId: string;
  label: string;
  currentRunRateUsd: number;
  recommendedBudgetUsd: number;
  deltaUsd: number;
  rationale: string;
  verdict?: ProductWorthVerdict;
}

export interface ProductWorthResponse {
  from: string;
  to: string;
  products: ProductWorthEntry[];
  summary: {
    productCount: number;
    worthItCount: number;
    notWorthItCount: number;
    totalSpendUsd: number;
    totalAttributedValueUsd: number;
    portfolioWorthRatio: number | null;
  };
  budgetSuggestions: BudgetSuggestionEntry[];
  dataCoverage: DataCoverageSummary;
  outcomeSources: OutcomeSourceStatus;
  importParityMessage: string | null;
}
