import type {
  CreateFixedCostInput,
  DeleteFixedCostInput,
  FixedCostRow,
  MonthlyFixedRow,
  TotalCostOfAiRow,
  UpdateFixedCostInput,
} from '@/types/fixed-costs';
import { combinedAiCost } from '@/lib/combined-ai-cost';

export type DateRangeParams = { from?: string; to?: string };

function formatApiError(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.detail === 'string') return body.detail;
  const msg = body.message;
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) return msg.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join(' · ');
  if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
    const nested = msg as Record<string, unknown>;
    if (typeof nested.message === 'string') return nested.message;
    if (Array.isArray(nested.message)) {
      return nested.message.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join(' · ');
    }
  }
  if (typeof body.error === 'string' && body.error !== 'create failed') return body.error;
  if (typeof body.title === 'string' && typeof body.detail === 'string') {
    return `${body.title}: ${body.detail}`;
  }
  return fallback;
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function fetchFixedCostRows(
  params?: DateRangeParams,
): Promise<{ rows: FixedCostRow[]; error?: string }> {
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  const suffix = qs.toString();
  const res = await fetch(`/api/fixed-costs${suffix ? `?${suffix}` : ''}`, { cache: 'no-store' });
  const body = await parseJson(res);
  if (!res.ok) {
    return { rows: [], error: formatApiError(body, 'Failed to load fixed overhead') };
  }
  return { rows: Array.isArray(body) ? (body as FixedCostRow[]) : [] };
}

export async function fetchFixedCostMonthly(params?: DateRangeParams): Promise<MonthlyFixedRow[]> {
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  const suffix = qs.toString();
  const res = await fetch(`/api/fixed-costs/monthly${suffix ? `?${suffix}` : ''}`, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? (data as MonthlyFixedRow[]) : [];
}

export async function fetchTotalCostOfAi(
  params?: DateRangeParams,
): Promise<{ rows: TotalCostOfAiRow[]; error?: string }> {
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  const suffix = qs.toString();
  const res = await fetch(`/api/fixed-costs/total-cost-of-ai${suffix ? `?${suffix}` : ''}`, { cache: 'no-store' });
  const body = await parseJson(res);
  if (!res.ok) {
    return { rows: [], error: formatApiError(body, 'Failed to load total cost of AI') };
  }
  return { rows: Array.isArray(body) ? (body as TotalCostOfAiRow[]) : [] };
}

export async function createFixedCost(
  input: CreateFixedCostInput,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const res = await fetch('/api/fixed-costs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parseJson(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error:
        res.status === 403
          ? 'Admin role required to save fixed overhead.'
          : formatApiError(body, 'Failed to save fixed overhead'),
    };
  }
  return { ok: true, data: body };
}

export async function updateFixedCost(
  input: UpdateFixedCostInput,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const res = await fetch('/api/fixed-costs', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parseJson(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error:
        res.status === 403
          ? 'Admin role required to save fixed overhead.'
          : formatApiError(body, 'Failed to update fixed overhead'),
    };
  }
  return { ok: true, data: body };
}

export async function deleteFixedCost(
  input: DeleteFixedCostInput,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const res = await fetch('/api/fixed-costs', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parseJson(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error:
        res.status === 403
          ? 'Admin role required to delete fixed overhead.'
          : formatApiError(body, 'Failed to delete fixed overhead'),
    };
  }
  return { ok: true };
}

export async function fetchMeteredSpend(params?: DateRangeParams): Promise<number> {
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  const suffix = qs.toString();
  const res = await fetch(`/api/analytics/spend-total${suffix ? `?${suffix}` : ''}`, { cache: 'no-store' });
  if (!res.ok) return 0;
  const body = (await res.json()) as { totalUsd?: number };
  return Number(body.totalUsd ?? 0);
}

/** @deprecated Use combinedAiCost(metered, rows) from @/lib/combined-ai-cost */
export function aggregateTotalCostOfAi(rows: TotalCostOfAiRow[]) {
  return combinedAiCost(0, rows);
}
