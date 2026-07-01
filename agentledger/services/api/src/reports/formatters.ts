import { formatPeriodChange, shouldRenderPctChange } from './executive-report.should-render';

/** Round to cents. */
export const usd = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Format currency to cents for tables (always 2 decimals). */
export function formatUsdExact(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Format currency to cents for display. Humanizes large values in summary contexts. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    return `${n < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 10_000) {
    return `${n < 0 ? '-' : ''}$${(abs / 1_000).toFixed(1)}K`;
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function formatInt(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

export function formatPct(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

export function formatPctShare(n: number): string {
  return `${n.toFixed(1)}%`;
}

export function formatTokens(n: number): string {
  return formatInt(n);
}

/** Plain-language executive one-liner from populated KPIs. */
export function buildOneLiner(data: {
  totalCost: number;
  priorCost: number;
  pctChange: number | null;
  calls: number;
  attributionLive: boolean;
  netValue: number | null;
  lari: number | null;
}): string {
  const parts: string[] = [];
  if (data.totalCost > 0) {
    parts.push(`AI spend was ${formatUsd(data.totalCost)}`);
    const change = formatPeriodChange(data.priorCost, data.totalCost, data.pctChange, formatPct);
    if (change) parts.push(change);
  }
  if (data.calls > 0) {
    parts.push(`${formatInt(data.calls)} model calls`);
  }
  if (data.attributionLive && data.netValue !== null && data.netValue !== 0) {
    parts.push(`net attributed value ${formatUsd(data.netValue)}`);
  }
  if (data.attributionLive && data.lari !== null) {
    parts.push(`LARI ${(data.lari * 100).toFixed(0)}%`);
  }
  if (parts.length === 0) {
    return 'No AI usage recorded in this period.';
  }
  return `${parts.join(', ')}.`;
}

/** Guard for tests: one-liner must not contain absurd period % when prior is immaterial. */
export function oneLinerHasImmateralPct(priorCost: number, oneLiner: string): boolean {
  if (priorCost >= 1) return false;
  return /[+-]?\d+\.?\d*%/.test(oneLiner.replace(/LARI \d+%/, ''));
}

export { shouldRenderPctChange, formatPeriodChange };
