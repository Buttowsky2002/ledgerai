import { proxyApi } from './api';
import { todayIso, type DateBounds } from './date-range';
import { resolveRange } from './resolve-range';

/** Earliest/latest spend days for date pickers (all-time bounds). */
export async function fetchDataBounds(
  searchParams: { from?: string; to?: string } = {},
): Promise<DateBounds> {
  const res = await proxyApi('/v1/analytics/data-bounds');
  if (res.ok && res.data && typeof res.data === 'object') {
    const b = res.data as { earliest_day?: string; latest_day?: string };
    if (b.earliest_day && b.latest_day) {
      return { earliest_day: b.earliest_day, latest_day: b.latest_day };
    }
  }
  const fallback = resolveRange(searchParams, 90);
  return { earliest_day: fallback.from, latest_day: fallback.to ?? todayIso() };
}
