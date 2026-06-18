const API_URL = process.env.AGENTLEDGER_API_URL ?? 'http://localhost:8094';

export type OidcProvider = 'google' | 'microsoft';

/** URL that starts the OIDC login flow at the API (wired; needs provider creds). */
export function loginUrl(provider: OidcProvider): string {
  return `${API_URL}/auth/login/${provider}`;
}

/** Dev mode = the API is trusted to accept x-tenant-id and a dev tenant is set. */
export function isDevMode(): boolean {
  return Boolean(process.env.AGENTLEDGER_DEV_TENANT_ID);
}

/** Common date-range default for analytics pages: trailing 30 days (UTC ISO dates). */
export function defaultRange(days = 30): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}
