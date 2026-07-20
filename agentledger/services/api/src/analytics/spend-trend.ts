export type SpendTrendDirection = 'up' | 'down' | 'flat' | 'insufficient';

export interface SpendTrendResult {
  direction: SpendTrendDirection;
  /** Percent change in average daily spend (latter half vs first half of range). */
  change_pct?: number;
  /** Dollar change in average daily spend (latter half avg minus first half avg). */
  change_usd?: number;
}

export interface DailySpendPoint {
  day: string;
  cost_usd: number;
}

/** Compare avg daily spend in the latter half of the period vs the first half. */
export function computeSpendTrend(daily: DailySpendPoint[], thresholdPct = 5): SpendTrendResult {
  if (daily.length < 2) {
    return { direction: 'insufficient' };
  }
  const sorted = [...daily].sort((a, b) => a.day.localeCompare(b.day));
  const mid = Math.floor(sorted.length / 2);
  const first = sorted.slice(0, mid);
  const second = sorted.slice(mid);
  if (first.length === 0 || second.length === 0) {
    return { direction: 'insufficient' };
  }
  const avg = (pts: DailySpendPoint[]) => pts.reduce((s, p) => s + p.cost_usd, 0) / pts.length;
  const avgFirst = avg(first);
  const avgSecond = avg(second);
  const changeUsd = roundUsd(avgSecond - avgFirst);
  if (avgFirst === 0 && avgSecond === 0) {
    return { direction: 'flat', change_pct: 0, change_usd: 0 };
  }
  if (avgFirst === 0) {
    return { direction: 'up', change_pct: 100, change_usd: changeUsd };
  }
  const changePct = ((avgSecond - avgFirst) / avgFirst) * 100;
  if (changePct > thresholdPct) {
    return { direction: 'up', change_pct: Math.round(changePct), change_usd: changeUsd };
  }
  if (changePct < -thresholdPct) {
    return { direction: 'down', change_pct: Math.round(changePct), change_usd: changeUsd };
  }
  return { direction: 'flat', change_pct: Math.round(changePct), change_usd: changeUsd };
}

function roundUsd(v: number): number {
  return Math.round(v * 100) / 100;
}
