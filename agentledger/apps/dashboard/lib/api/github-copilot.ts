import type {
  CopilotConnectionStatus,
  CopilotMemberSpendResponse,
  CopilotOverviewResponse,
  CopilotRoiAssumptions,
  SyncResult,
} from '@/types/github-copilot';

async function parseJson<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function extractApiError(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const body = data as Record<string, unknown>;
    if (typeof body.errorMessage === 'string') return body.errorMessage;
    if (typeof body.message === 'string') return body.message;
    if (typeof body.error === 'string') return body.error;
    if (body.message && typeof body.message === 'object') {
      const nested = body.message as Record<string, unknown>;
      if (typeof nested.message === 'string') return nested.message;
      if (typeof nested.hint === 'string') return nested.hint;
    }
  }
  return `Request failed (${status})`;
}

export async function syncCopilotConnection(connectionId: string): Promise<SyncResult | null> {
  const res = await fetch(`/api/github-copilot/connections/${connectionId}/sync`, { method: 'POST' });
  const data = await parseJson<SyncResult & { message?: string; error?: string }>(res);
  if (!data) {
    return {
      ok: false,
      seatsImported: 0,
      usageRowsImported: 0,
      roiRowsComputed: 0,
      errorMessage: `Sync request failed (${res.status})`,
    };
  }
  if (!res.ok && data.ok !== false) {
    return {
      ok: false,
      seatsImported: 0,
      usageRowsImported: 0,
      roiRowsComputed: 0,
      errorMessage: extractApiError(data, res.status),
    };
  }
  return data;
}

export async function fetchCopilotOverview(from: string, to: string): Promise<CopilotOverviewResponse | null> {
  const qs = new URLSearchParams({ from, to });
  const res = await fetch(`/api/github-copilot/overview?${qs}`);
  return parseJson<CopilotOverviewResponse>(res);
}

export async function fetchCopilotConnections(): Promise<CopilotConnectionStatus[]> {
  const res = await fetch('/api/github-copilot/connections');
  const data = await parseJson<CopilotConnectionStatus[]>(res);
  return data ?? [];
}

export async function testCopilotToken(
  githubToken: string,
  orgSlug: string,
): Promise<{ ok: boolean; orgName?: string; hint?: string }> {
  const res = await fetch('/api/github-copilot/connections/test-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ githubToken, orgSlug }),
  });
  return (await parseJson(res)) ?? { ok: false, hint: 'Request failed' };
}

export async function createCopilotConnection(body: {
  displayName: string;
  orgSlug: string;
  githubToken: string;
  enterpriseSlug?: string;
}): Promise<CopilotConnectionStatus | null> {
  const res = await fetch('/api/github-copilot/connections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseJson<CopilotConnectionStatus>(res);
}

export async function fetchCopilotMemberSpend(params: {
  from: string;
  to: string;
  month?: string;
  user?: string;
  utilizationStatus?: string;
  model?: string;
  editor?: string;
  language?: string;
}): Promise<CopilotMemberSpendResponse | null> {
  const qs = new URLSearchParams({ from: params.from, to: params.to });
  if (params.month) qs.set('month', params.month);
  if (params.user) qs.set('user', params.user);
  if (params.utilizationStatus) qs.set('utilizationStatus', params.utilizationStatus);
  if (params.model) qs.set('model', params.model);
  if (params.editor) qs.set('editor', params.editor);
  if (params.language) qs.set('language', params.language);
  const res = await fetch(`/api/github-copilot/member-spend?${qs}`);
  return parseJson<CopilotMemberSpendResponse>(res);
}

export async function updateCopilotAssumptions(
  connectionId: string,
  roiAssumptions: Partial<CopilotRoiAssumptions>,
): Promise<CopilotConnectionStatus | null> {
  const res = await fetch(`/api/github-copilot/connections/${connectionId}/roi-assumptions`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roiAssumptions }),
  });
  return parseJson<CopilotConnectionStatus>(res);
}
