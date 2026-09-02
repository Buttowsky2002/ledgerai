import { defaultRange } from './auth';
import { proxyApi } from './api';
import { todayIso, type DateBounds } from './date-range';

/** Earliest/latest spend days for date pickers (all-time bounds). */
export async function fetchDataBounds(): Promise<DateBounds> {
  const res = await proxyApi('/v1/analytics/data-bounds');
  if (res.ok && res.data && typeof res.data === 'object') {
    const b = res.data as { earliest_day?: string; latest_day?: string };
    if (b.earliest_day && b.latest_day) {
      return { earliest_day: b.earliest_day, latest_day: b.latest_day };
    }
  }
  // Never reuse the active page range as picker bounds — that caps "to" at the
  // current selection and blocks looking back before "from".
  const wide = defaultRange(365);
  return { earliest_day: wide.from, latest_day: todayIso() };
}
