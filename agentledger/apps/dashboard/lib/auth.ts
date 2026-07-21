import { env } from './env';

/** Public origin for browser-facing links (OIDC login). Not the Cloud Map API URL. */
const PUBLIC_URL = env('BADGERIQ_PUBLIC_URL') ?? 'http://localhost:8094';

export type OidcProvider = 'google' | 'microsoft';

/** URL that starts the OIDC login flow at the API (wired; needs provider creds). */
export function loginUrl(provider: OidcProvider): string {
  return `${PUBLIC_URL}/auth/login/${provider}`;
}

/** Same-origin (or public-host) logout — clears al_access / al_refresh via the API. */
export function logoutUrl(): string {
  return `${PUBLIC_URL}/auth/logout`;
}

/** Dev mode = the API is trusted to accept x-tenant-id and a dev tenant is set. */
export function isDevMode(): boolean {
  return Boolean(env('BADGERIQ_DEV_TENANT_ID'));
}

/** Common date-range default for analytics pages: trailing 90 days (UTC ISO dates). */
export function defaultRange(days = 90): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}
