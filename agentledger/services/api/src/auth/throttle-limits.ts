/**
 * Per-route auth / SCIM rate limits (security rule 6).
 * Global default remains 100/60s via ThrottlerModule; these tighten sensitive paths.
 */
export const AUTH_THROTTLE = {
  /** Login / OIDC / SSO initiation — credential stuffing surface. */
  login: { default: { limit: 5, ttl: 60_000 } },
  /** Token refresh — higher than login, still tight. */
  refresh: { default: { limit: 10, ttl: 60_000 } },
  /** OIDC / SSO callback — must tolerate redirect bursts. */
  callback: { default: { limit: 20, ttl: 60_000 } },
} as const;

/** SCIM bearer-token provisioning — IdP sync bursts, not open to browsers. */
export const SCIM_THROTTLE = { default: { limit: 30, ttl: 60_000 } } as const;
