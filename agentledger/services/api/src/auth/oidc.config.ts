/**
 * OIDC provider configuration, built from environment at startup. Per repo rule 1,
 * secrets are never in files — client secrets come from env vars by name. A
 * provider whose client id/secret env vars are unset is simply omitted (unavailable),
 * so a deployment enables only the providers it has credentials for.
 */
import { env } from '../env';

export interface OidcProviderConfig {
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

interface ProviderEnvSpec {
  name: string;
  defaultIssuer: string;
  issuerEnv: string;
  clientIdEnv: string;
  clientSecretEnv: string;
}

const SPECS: ProviderEnvSpec[] = [
  {
    name: 'google',
    defaultIssuer: 'https://accounts.google.com',
    issuerEnv: 'BADGERIQ_OIDC_GOOGLE_ISSUER',
    clientIdEnv: 'BADGERIQ_OIDC_GOOGLE_CLIENT_ID',
    clientSecretEnv: 'BADGERIQ_OIDC_GOOGLE_CLIENT_SECRET',
  },
  {
    name: 'microsoft',
    defaultIssuer: 'https://login.microsoftonline.com/common/v2.0',
    issuerEnv: 'BADGERIQ_OIDC_MICROSOFT_ISSUER',
    clientIdEnv: 'BADGERIQ_OIDC_MICROSOFT_CLIENT_ID',
    clientSecretEnv: 'BADGERIQ_OIDC_MICROSOFT_CLIENT_SECRET',
  },
];

/** Base URL the IdP redirects back to (shared by global + per-tenant SSO flows). */
export function redirectBase(): string {
  return env('BADGERIQ_OIDC_REDIRECT_BASE') ?? 'http://localhost:8094';
}

/** Redirect URI for the per-tenant SSO callback (P6-D1). */
export function ssoRedirectUri(): string {
  return `${redirectBase()}/auth/sso/callback`;
}

// Secret-ref resolution moved to ./secret-resolver (env → AWS Secrets Manager, ADR-049).

export function loadOidcProviders(): OidcProviderConfig[] {
  const base = env('BADGERIQ_OIDC_REDIRECT_BASE') ?? 'http://localhost:8094';
  const providers: OidcProviderConfig[] = [];
  for (const spec of SPECS) {
    const clientId = process.env[spec.clientIdEnv];
    const clientSecret = process.env[spec.clientSecretEnv];
    if (!clientId || !clientSecret) {
      continue; // not configured → unavailable
    }
    providers.push({
      name: spec.name,
      issuer: process.env[spec.issuerEnv] ?? spec.defaultIssuer,
      clientId,
      clientSecret,
      redirectUri: `${base}/auth/callback/${spec.name}`,
      scopes: ['openid', 'email', 'profile'],
    });
  }
  return providers;
}
