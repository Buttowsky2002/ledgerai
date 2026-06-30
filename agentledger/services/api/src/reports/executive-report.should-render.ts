import type {
  DailySpendRow,
  ExecutiveReportData,
  ProviderSpendRow,
  RiskRollupRow,
  UserSpendRow,
  ValueMetrics,
} from './executive-report.types';

/** Inclusive day count between ISO dates (UTC). */
export function daysBetweenInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86_400_000) + 1);
}

/** Shift an ISO date by delta days (UTC). */
export function addDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Compute the prior equivalent window immediately before `from`. */
export function priorWindow(from: string, to: string): { from: string; to: string } {
  const days = daysBetweenInclusive(from, to);
  const priorTo = addDays(from, -1);
  const priorFrom = addDays(from, -days);
  return { from: priorFrom, to: priorTo };
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Minimum prior-period spend (USD) before showing a % change. */
export const PRIOR_PCT_MIN_USD = 1;

/** Prior must also reach this share of current spend to be a meaningful baseline. */
export const PRIOR_PCT_MIN_SHARE = 0.05;

export const NEW_SPEND_LABEL = 'New spend (no comparable prior period)';

/** Prior spend floor for period-over-period % — absolute and relative to current. */
export function priorMaterialityThreshold(currentCost: number): number {
  return Math.max(PRIOR_PCT_MIN_USD, currentCost * PRIOR_PCT_MIN_SHARE);
}

/** Period-over-period percent change; null when prior is below materiality threshold. */
export function periodDeltaPct(current: number, prior: number): number | null {
  if (prior < priorMaterialityThreshold(current)) return null;
  return round2(((current - prior) / prior) * 100);
}

export function shouldRenderPctChange(priorCost: number, currentCost: number): boolean {
  return priorCost >= priorMaterialityThreshold(currentCost);
}

/** Single source of truth for KPI band, one-liner, and XLSX — never emits % when prior is immaterial. */
export function formatPeriodChange(
  priorCost: number,
  currentCost: number,
  pctChange: number | null,
  formatPctFn: (n: number) => string,
): string | null {
  if (currentCost <= 0) return null;
  if (priorCost < priorMaterialityThreshold(currentCost)) return NEW_SPEND_LABEL;
  if (pctChange !== null && shouldRenderPctChange(priorCost, currentCost)) return formatPctFn(pctChange);
  return null;
}

/** @deprecated use formatPeriodChange */
export function periodChangeDisplay(priorCost: number, currentCost: number): string | null {
  if (currentCost <= 0) return null;
  if (priorCost < priorMaterialityThreshold(currentCost)) return NEW_SPEND_LABEL;
  return null;
}

export function shouldShowPctValue(priorCost: number, currentCost: number, pctChange: number | null): pctChange is number {
  return shouldRenderPctChange(priorCost, currentCost) && pctChange !== null;
}

export function shouldRenderSummary(data: ExecutiveReportData): boolean {
  return data.current.costUsd > 0 || data.current.calls > 0;
}

export function shouldRenderCostPer1k(totalTokens: number): boolean {
  return totalTokens > 0;
}

export function shouldRenderValueKpis(
  attributionLive: boolean,
  metrics: ValueMetrics | null,
): boolean {
  return attributionLive && metrics !== null && metrics.outcomes >= 1;
}

export function shouldRenderSpendTrend(rows: DailySpendRow[]): boolean {
  return rows.some((r) => r.costUsd > 0);
}

export function shouldRenderPriorGhost(rows: DailySpendRow[]): boolean {
  return rows.some((r) => r.costUsd > 0);
}

export function shouldRenderUserSpend(rows: { costUsd: number }[]): boolean {
  return rows.some((r) => r.costUsd > 0);
}

export function shouldRenderProviderChart(providers: ProviderSpendRow[]): boolean {
  return providers.filter((p) => p.costUsd > 0).length >= 2;
}

export function shouldRenderSingleProviderLabel(providers: ProviderSpendRow[]): boolean {
  return providers.filter((p) => p.costUsd > 0).length === 1;
}

export function shouldRenderCacheCallout(cachedTokens: number): boolean {
  return cachedTokens > 0;
}

export function shouldRenderRisk(blockedEvents: number, rows: RiskRollupRow[]): boolean {
  if (blockedEvents > 0) return true;
  return rows.some((r) => r.dlpAction !== 'allow' && r.events > 0);
}

/** Top 15 users plus optional "All others" rollup. */
export function rollupUserSpend(rows: UserSpendRow[], topN = 15): UserSpendRow[] {
  const sorted = [...rows].filter((r) => r.costUsd > 0).sort((a, b) => b.costUsd - a.costUsd);
  if (sorted.length === 0) return [];
  if (sorted.length <= topN) return sorted;
  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  const others: UserSpendRow = {
    userId: '__others__',
    displayName: 'All others',
    teamName: '',
    costUsd: round2(rest.reduce((s, r) => s + r.costUsd, 0)),
    calls: rest.reduce((s, r) => s + r.calls, 0),
  };
  return [...top, others];
}
