import type { ModelSpendTableRow, UserSpendTableRow } from './report-tables';

/** Raw spend totals from spend_daily. */
export interface SpendTotals {
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** One day in the spend trend series. */
export interface DailySpendRow {
  day: string;
  costUsd: number;
}

/** User spend row enriched with display names from Postgres. */
export interface UserSpendRow {
  userId: string;
  displayName: string;
  teamName: string;
  costUsd: number;
  calls: number;
}

export interface ProviderSpendRow {
  provider: string;
  costUsd: number;
  calls: number;
  costBasis?: 'subscription' | 'usage' | null;
}

export interface PlatformBreakdownRow {
  provider: string;
  costUsd: number;
  calls: number;
  costBasis: 'subscription' | 'usage';
  models: ModelSpendRow[];
  remainderUsd: number;
}

export interface ModelSpendRow {
  provider: string;
  model: string;
  costUsd: number;
  calls: number;
}

export interface RiskRollupRow {
  dlpAction: string;
  riskSeverity: string;
  events: number;
}

/** Headline value metrics from v_roi (attribution-live tenants only). */
export interface ValueMetrics {
  outcomes: number;
  businessValueUsd: number;
  fullyLoadedCostUsd: number;
  netValueUsd: number;
  riskAdjustedRoiUsd: number;
  lari: number | null;
  avgConfidence: number;
}

/** Fully assembled executive report payload before export. */
export interface ExecutiveReportData {
  tenantName: string;
  window: { from: string; to: string; days: number };
  priorWindow: { from: string; to: string };
  attributionLive: boolean;
  current: SpendTotals;
  prior: SpendTotals;
  pctChangeVsPrior: number | null;
  costPer1kTokens: number | null;
  valueMetrics: ValueMetrics | null;
  spendTrend: DailySpendRow[];
  priorSpendTrend: DailySpendRow[];
  userSpend: UserSpendRow[];
  userSpendTable: UserSpendTableRow[];
  modelSpendTable: ModelSpendTableRow[];
  providers: ProviderSpendRow[];
  models: ModelSpendRow[];
  platformBreakdown: PlatformBreakdownRow[];
  risk: RiskRollupRow[];
  blockedEvents: number;
  oneLiner: string;
}
