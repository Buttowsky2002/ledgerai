import type { paths } from '@agentledger/shared-types';
import createClient from 'openapi-fetch';
import { cookies } from 'next/headers';
import { env } from './env';

const API_URL = env('LEDGERAI_API_URL') ?? 'http://localhost:8094';
// Dev-only tenant fallback: never resolved in production, so the x-tenant-id
// header is never sent in prod (the API would refuse to trust it anyway).
const DEV_TENANT = process.env.NODE_ENV !== 'production' ? env('LEDGERAI_DEV_TENANT_ID') : undefined;

/**
 * Server-side typed client for the control-plane API (BFF pattern — never runs in
 * the browser, so no token is exposed and there's no CORS). Auth resolution:
 *   1. `al_access` session cookie → `Authorization: Bearer` (post-OIDC, prod).
 *   2. else, outside production only, `LEDGERAI_DEV_TENANT_ID` → `x-tenant-id`
 *      (dev, API trusts the header). Never sent in production.
 * If neither is set, requests are unauthenticated and the API returns 401.
 */
export function apiClient() {
  const headers: Record<string, string> = {};
  const token = cookies().get('al_access')?.value;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else if (DEV_TENANT) {
    headers['x-tenant-id'] = DEV_TENANT;
  }
  return createClient<paths>({ baseUrl: API_URL, headers });
}

/** Convenience: run a GET and return its data or a fallback (logs API errors). */
export async function fetchData<T>(promise: Promise<{ data?: T; error?: unknown }>, fallback: T): Promise<T> {
  const { data, error } = await promise;
  if (error || data === undefined) {
    return fallback;
  }
  return data;
}
