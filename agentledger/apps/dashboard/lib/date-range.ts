import { defaultRange } from './auth';

/** Parse ?from=&to= search params, falling back to trailing N days. */
export function parseRange(
  searchParams: { from?: string; to?: string },
  defaultDays = 30,
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
