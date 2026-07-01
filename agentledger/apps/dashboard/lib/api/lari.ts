import type { CfoViewResponse, LariRecommendationsResponse } from '@/types/lari';

export type CfoViewParams = {
  startDate?: string;
  endDate?: string;
  confidenceThreshold?: number;
};

/** Fetch tenant CFO view from the dashboard BFF (proxies /v1/lari/cfo-view). */
export async function fetchCfoView(params: CfoViewParams): Promise<CfoViewResponse | null> {
  const qs = new URLSearchParams();
  if (params.startDate) qs.set('startDate', params.startDate);
  if (params.endDate) qs.set('endDate', params.endDate);
  if (params.confidenceThreshold !== undefined) {
    qs.set('confidenceThreshold', String(params.confidenceThreshold));
  }
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
