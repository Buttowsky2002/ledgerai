import { cookies } from 'next/headers';
import {
  RANGE_COOKIE,
  resolveRangeWithCookie,
  type DateBounds,
  type ResolvedRange,
} from './date-range';

/** URL params win; else cookie; else trailing-N-days default. */
export { resolveRangeWithCookie } from './date-range';

/** URL params win; else cookie; else trailing-N-days default. */
export function resolveRange(
  searchParams: { from?: string; to?: string },
  defaultDays = 90,
): { from: string; to: string } {
  return resolveRangeWithCookie(searchParams, cookies().get(RANGE_COOKIE)?.value, defaultDays);
}

/** Cookie-aware range resolution with all-time support via ?range=all. */
export function resolvePageRangeWithCookie(
  searchParams: { from?: string; to?: string; range?: string },
  bounds: DateBounds,
  cookieRaw: string | undefined,
  defaultDays = 90,
): ResolvedRange {
  if (searchParams.range === 'all') {
    return { from: bounds.earliest_day, to: bounds.latest_day, isAllTime: true };
  }
  const { from, to } = resolveRangeWithCookie(searchParams, cookieRaw, defaultDays);
  const isAllTime = from === bounds.earliest_day && to === bounds.latest_day;
  return { from, to, isAllTime };
}

export function resolvePageRange(
  searchParams: { from?: string; to?: string; range?: string },
  bounds: DateBounds,
  defaultDays = 90,
): ResolvedRange {
  return resolvePageRangeWithCookie(
    searchParams,
    bounds,
    cookies().get(RANGE_COOKIE)?.value,
    defaultDays,
  );
}
