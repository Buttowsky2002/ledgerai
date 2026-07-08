import { Stat, usd } from '@/components/ui';
import type { CfoViewSummary } from '@/types/lari';

export function costPerOutcomeDisplay(
  summary: CfoViewSummary,
  outcomeCount: number,
): { value: string; sub: string } {
  if (outcomeCount > 0 && summary.costPerOutcome != null) {
    return {
      value: usd(summary.costPerOutcome),
      sub: `${outcomeCount} attributed outcome${outcomeCount === 1 ? '' : 's'}`,
    };
  }
  if (summary.costPerOutcomeFallback != null && summary.costPerOutcomeFallbackLabel) {
    return {
      value: usd(summary.costPerOutcomeFallback),
      sub: `${summary.costPerOutcomeFallbackLabel} · proxy until outcomes linked`,
    };
  }
  return { value: '—', sub: 'Link outcomes to compute' };
}

export function CostPerOutcomeStat({
  summary,
  outcomeCount,
  subOverride,
}: {
  summary: CfoViewSummary;
  outcomeCount: number;
  /** Optional subtext override (e.g. forecast horizon on cost-per-outcome page). */
  subOverride?: string;
}) {
  const { value, sub } = costPerOutcomeDisplay(summary, outcomeCount);
  return <Stat label="Cost per outcome" value={value} sub={subOverride ?? sub} />;
}
