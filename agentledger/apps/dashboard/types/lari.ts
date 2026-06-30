/** Tenant-level CFO view response — mirrors GET /v1/lari/cfo-view. */
export interface CfoViewSummary {
  riskAdjustedRoi: number;
  nominalRoi: number;
  businessValue: number;
  fullyLoadedCost: number;
  forecastPerMonth: number;
  roiMargin: number;
  runRateMonths: number;
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
}

export interface CfoViewProviderBreakdown {
  provider: string;
  costUsd: number;
  calls: number;
}

export interface CfoViewResponse {
  from: string;
  to: string;
  confidenceThreshold: number;
  summary: CfoViewSummary;
  monthly: CfoViewMonthly[];
  outcomeBreakdown: CfoViewOutcomeBreakdown[];
  providerBreakdown: CfoViewProviderBreakdown[];
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
  | 'configuration';

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
  relatedEntity?: { type: 'agent' | 'provider' | 'plan' | 'user'; id: string };
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
