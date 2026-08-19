import type { ProviderValueRanking } from './lari-recommendations.types';

/** Whether spend on a product is justified by outcomes or utilization signals. */
export type ProductWorthVerdict = 'worth_it' | 'marginal' | 'not_worth_it' | 'insufficient_data';

/** How the confidence score was derived — auditable, no LLM. */
export type ProductConfidenceBasis =
  | 'outcomes'
  | 'utilization'
  | 'productivity_proxy'
  | 'mixed'
  | 'none';

export type SpendDriverType = 'user' | 'model' | 'seat_waste';

export type SpendTrend = 'up' | 'down' | 'flat' | 'insufficient';

export type ProductDataMode = 'import_only' | 'live_only' | 'mixed' | 'unknown';

/** Raw ingest breakdown — portal CSV vs API connector vs live telemetry. */
export interface ProductSpendBySource {
  portalImportUsd: number;
  connectorUsd: number;
  liveUsd: number;
  portalImportCalls: number;
  connectorCalls: number;
  liveCalls: number;
}

/** Top contributor to spend on a product — explains the "why". */
export interface ProductSpendDriver {
  type: SpendDriverType;
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
  /** null when spend is zero or value cannot be compared. */
  worthRatio: number | null;
  verdict: ProductWorthVerdict;
  /** 0–100 — higher = more confident in the verdict. */
  confidenceScore: number;
  confidenceBasis: ProductConfidenceBasis;
  /** Observed spend normalized to a 30-day month. */
  monthlyRunRateUsd: number;
  /** Suggested monthly cap — advisory, derived from run-rate and optimization potential. */
  recommendedBudgetUsd: number | null;
  topDrivers: ProductSpendDriver[];
  /** Deterministic explanation of why spend looks the way it does. */
  spendNarrative: string;
  spendTrend: SpendTrend;
  periodChangePct: number | null;
  periodChangeUsd: number | null;
  /** True when outcome connectors would unlock a stronger verdict. */
  connectOutcomesPrompt: boolean;
  /** Where spend data was ingested from — enables import parity display. */
  spendBySource?: ProductSpendBySource;
  dataMode?: ProductDataMode;
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

export interface ProductWorthSummary {
  productCount: number;
  worthItCount: number;
  notWorthItCount: number;
  totalSpendUsd: number;
  totalAttributedValueUsd: number;
  portfolioWorthRatio: number | null;
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

export interface ProductWorthResponse {
  from: string;
  to: string;
  products: ProductWorthEntry[];
  summary: ProductWorthSummary;
  budgetSuggestions: BudgetSuggestionEntry[];
  dataCoverage: DataCoverageSummary;
  outcomeSources: OutcomeSourceStatus;
  /** Plain-language import/outcome parity status — null when fully healthy. */
  importParityMessage: string | null;
}

/** Inputs for the pure product-worth engine — subset of LariRecommendationsInput. */
export interface ProductWorthInput {
  periodDays: number;
  providerSpend: Array<{ provider: string; costUsd: number; calls: number }>;
  subscriptionPlans: Array<{
    provider: string;
    seatsPurchased: number;
    contractMonthlyCost: number;
    activeSeats: number;
  }>;
  providerRankings: ProviderValueRanking[];
  modelUsage: Array<{ provider: string; model: string; costUsd: number }>;
  userUtilization: Array<{
    displayName: string;
    providers: string[];
    costUsd: number;
    status: string;
    hasSeat: boolean;
    seatProvider?: string;
    seatMonthlyCostUsd: number;
  }>;
  copilotRoiPct?: number;
  /** Prior period provider spend for period-over-period narratives. */
  priorProviderSpend?: Array<{ provider: string; costUsd: number }>;
  /** Prior period model usage for shift detection. */
  priorModelUsage?: Array<{ provider: string; model: string; costUsd: number }>;
  /** Tenant daily spend (all products) for trend z-scores. */
  dailySpend?: Array<{ day: string; costUsd: number }>;
  /** Agent economics for agent-level budget suggestions. */
  agents?: Array<{
    agentId: string;
    costUsd: number;
    valueUsd: number;
    lari: number;
    recommendation: string;
  }>;
  /** Per-provider raw ingest source breakdown. */
  spendBySource?: Map<string, ProductSpendBySource>;
  /** Tenant outcome + ROI linkage stats. */
  outcomeStats?: OutcomeStats;
  importStats?: ImportStats;
  connectors?: ConnectorPresence;
}

export interface OutcomeStats {
  totalOutcomes: number;
  importOutcomes: number;
  connectorOutcomes: number;
  apiOutcomes: number;
  totalValueUsd: number;
  roiLinkedOutcomes: number;
  roiLinkedValueUsd: number;
  headlineEligibleOutcomes: number;
}

export interface ImportStats {
  portalImportRuns: number;
  bulkImportEvents: number;
}

export interface ConnectorPresence {
  billingConnectors: string[];
  outcomeConnectors: string[];
}
