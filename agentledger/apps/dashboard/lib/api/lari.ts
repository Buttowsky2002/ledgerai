import type { CfoViewResponse, CostBasisMode, LariRecommendationsResponse, UserValueResponse } from '@/types/lari';

export type CfoViewParams = {
  startDate?: string;
  endDate?: string;
  costBasis?: CostBasisMode;
  forecastDays?: number;
};

/** Fetch tenant CFO view from the dashboard BFF (proxies /v1/lari/cfo-view). */
export async function fetchCfoView(params: CfoViewParams): Promise<CfoViewResponse | null> {
  const qs = new URLSearchParams();
  if (params.startDate) qs.set('startDate', params.startDate);
  if (params.endDate) qs.set('endDate', params.endDate);
  if (params.costBasis) qs.set('costBasis', params.costBasis);
  if (params.forecastDays !== undefined) qs.set('forecastDays', String(params.forecastDays));
  const suffix = qs.toString();
  const res = await fetch(`/api/lari/cfo-view${suffix ? `?${suffix}` : ''}`, {
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return (await res.json()) as CfoViewResponse;
}

export type RecommendationsParams = {
  startDate?: string;
  endDate?: string;
};

/** Fetch LARI savings + configuration recommendations. */
export async function fetchLariRecommendations(
  params: RecommendationsParams,
): Promise<LariRecommendationsResponse | null> {
  const qs = new URLSearchParams();
  if (params.startDate) qs.set('startDate', params.startDate);
  if (params.endDate) qs.set('endDate', params.endDate);
  const suffix = qs.toString();
  const res = await fetch(`/api/lari/recommendations${suffix ? `?${suffix}` : ''}`, {
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return (await res.json()) as LariRecommendationsResponse;
}

export type UserValueParams = {
  from?: string;
  to?: string;
};

/** Fetch per-user / team-level platform utilization correlation. */
export async function fetchUserValue(params: UserValueParams): Promise<UserValueResponse | null> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const suffix = qs.toString();
  const res = await fetch(`/api/analytics/user-value${suffix ? `?${suffix}` : ''}`, {
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return (await res.json()) as UserValueResponse;
}
