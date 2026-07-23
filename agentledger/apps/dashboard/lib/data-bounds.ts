import { proxyApi } from './api';
import { defaultRange } from './auth';
import { todayIso, type DateBounds } from './date-range';

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
  // Never fall back to the cookie/page range — that collapses "All time" to last 7d.
  void searchParams;
  const fallback = defaultRange(90);
  return { earliest_day: fallback.from, latest_day: fallback.to ?? todayIso() };
}
