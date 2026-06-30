import { Recommendation } from './lari.types';

/** Priority band for actionable savings / configuration recommendations. */
export type RecommendationPriority = 'low' | 'medium' | 'high' | 'critical';

export type RecommendationCategory =
  | 'seat_optimization'
  | 'plan_optimization'
  | 'provider_value'
  | 'agent_economics'
  | 'attribution'
  | 'configuration';

export interface LariActionableRecommendation {
  id: string;
  priority: RecommendationPriority;
  category: RecommendationCategory;
  title: string;
  message: string;
  /** Suggested next step — content-free, auditable. */
  action: string;
  /** Estimated monthly savings when applicable (advisory, not a guarantee). */
  estimatedSavingsUsd?: number;
  /** Broader financial impact in the query window (USD). */
  estimatedImpactUsd?: number;
  /** Composite ML score in [0,100] — higher = more urgent / higher expected impact. */
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
  /** Percentile efficiency score in [0,100] from ML ranking. */
  efficiencyScore: number;
  rank: number;
}

export interface AgentEconomicsHighlight {
  agentId: string;
  costUsd: number;
  valueUsd: number;
  lari: number;
  confidenceScore: number;
  recommendation: Recommendation;
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

/** Inputs for the pure recommendation engine — assembled by the service layer. */
export interface LariRecommendationsInput {
  from: string;
  to: string;
  periodDays: number;
  seatStats: { purchased: number; active: number };
  subscriptionPlans: Array<{
    planId: string;
    provider: string;
    planName: string;
    seatsPurchased: number;
    contractMonthlyCost: number;
    monthlyPricePerUser: number;
    activeSeats: number;
  }>;
  providerSpend: Array<{ provider: string; costUsd: number; calls: number }>;
  dailySpend: Array<{ day: string; costUsd: number }>;
  unmappedCostUsd: number;
  agentEconomics: AgentEconomicsHighlight[];
  agentProviderSpend: Array<{ agentId: string; provider: string; costUsd: number }>;
  copilotInactiveSeats?: number;
  copilotSeatMonthlyCost?: number;
}
