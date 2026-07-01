import type { paths } from '@agentledger/shared-types';
import createClient from 'openapi-fetch';
import { cookies } from 'next/headers';
import { env } from './env';

const API_URL = env('BADGERIQ_API_URL') ?? 'http://localhost:8094';

/** Dev/demo tenant for server-side BFF calls when no session cookie is present. */
function devTenantId(): string | undefined {
  const id = env('BADGERIQ_DEV_TENANT_ID');
  if (!id) return undefined;
  if (process.env.NODE_ENV !== 'production') return id;
  // Standalone Docker runs NODE_ENV=production; honor dev tenant for local stacks
  // (API only accepts x-tenant-id when DEV_TRUST_HEADER is enabled).
  if (env('BADGERIQ_DEMO_MODE') === 'true') return id;
  if (env('BADGERIQ_DEV_TRUST_TENANT') === 'true') return id;
  return undefined;
}

/**
 * Server-side typed client for the control-plane API (BFF pattern — never runs in
 * the browser, so no token is exposed and there's no CORS). Auth resolution:
 *   1. `al_access` session cookie → `Authorization: Bearer` (post-OIDC, prod).
 *   2. else, when configured, `BADGERIQ_DEV_TENANT_ID` → `x-tenant-id`
 *      (dev / local docker; API trusts the header only with DEV_TRUST_HEADER).
 * If neither is set, requests are unauthenticated and the API returns 401.
 */
export function apiClient() {
  const headers: Record<string, string> = {};
  const token = cookies().get('al_access')?.value;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    const devTenant = devTenantId();
    if (devTenant) headers['x-tenant-id'] = devTenant;
  }
  return createClient<paths>({ baseUrl: API_URL, headers });
}

/** Auth headers for BFF routes not yet in the generated OpenAPI client. */
export function apiAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = cookies().get('al_access')?.value;
  if (token) headers.Authorization = `Bearer ${token}`;
  else {
    const devTenant = devTenantId();
    if (devTenant) headers['x-tenant-id'] = devTenant;
  }
  return headers;
}

/** Proxy an API call until the route is added to docs/api/openapi.json. */
export async function proxyApi(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers = { ...apiAuthHeaders(), ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text.slice(0, 500) };
    }
  }
  return { ok: res.ok, status: res.status, data };
}

/** Convenience: run a GET and return its data or a fallback (logs API errors). */
export async function fetchData<T>(promise: Promise<{ data?: T; error?: unknown }>, fallback: T): Promise<T> {
  const { data, error } = await promise;
  if (error || data === undefined) {
    return fallback;
  }
  return data;
}
