import { defaultRange } from './auth';

/** UTC ISO date (YYYY-MM-DD) for today. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Parse ?from=&to= search params, falling back to trailing N days. */
export function parseRange(
  searchParams: { from?: string; to?: string },
  defaultDays = 90,
): { from: string; to: string } {
  const from = searchParams.from?.slice(0, 10);
  const to = searchParams.to?.slice(0, 10);
  if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { from, to };
  }
  return defaultRange(defaultDays);
}

export function rangeHref(
  basePath: string,
  from: string,
  to: string,
  extra?: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  params.set('from', from);
  params.set('to', to);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) params.set(k, v);
    }
  }
  return `${basePath}?${params.toString()}`;
}

export function presetRange(days: number): { from: string; to: string } {
  return defaultRange(days);
}

export type DateBounds = { earliest_day: string; latest_day: string };

export type ResolvedRange = { from: string; to: string; isAllTime: boolean };

/** Resolve URL params to a concrete from/to, honoring ?range=all against server bounds. */
export function resolveRange(
  searchParams: { from?: string; to?: string; range?: string },
  bounds: DateBounds,
  defaultDays = 90,
): ResolvedRange {
  if (searchParams.range === 'all') {
    return { from: bounds.earliest_day, to: bounds.latest_day, isAllTime: true };
  }
  const { from, to } = parseRange(searchParams, defaultDays);
  const isAllTime = from === bounds.earliest_day && to === bounds.latest_day;
  return { from, to, isAllTime };
}

export function allTimeHref(basePath: string, extra?: Record<string, string | undefined>): string {
  const params = new URLSearchParams({ range: 'all' });
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) params.set(k, v);
    }
  }
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
