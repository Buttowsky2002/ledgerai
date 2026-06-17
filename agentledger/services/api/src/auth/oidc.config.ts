/**
 * OIDC provider configuration, built from environment at startup. Per repo rule 1,
 * secrets are never in files — client secrets come from env vars by name. A
 * provider whose client id/secret env vars are unset is simply omitted (unavailable),
 * so a deployment enables only the providers it has credentials for.
 */
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
    issuerEnv: 'AGENTLEDGER_OIDC_GOOGLE_ISSUER',
    clientIdEnv: 'AGENTLEDGER_OIDC_GOOGLE_CLIENT_ID',
    clientSecretEnv: 'AGENTLEDGER_OIDC_GOOGLE_CLIENT_SECRET',
  },
  {
    name: 'microsoft',
    defaultIssuer: 'https://login.microsoftonline.com/common/v2.0',
    issuerEnv: 'AGENTLEDGER_OIDC_MICROSOFT_ISSUER',
    clientIdEnv: 'AGENTLEDGER_OIDC_MICROSOFT_CLIENT_ID',
    clientSecretEnv: 'AGENTLEDGER_OIDC_MICROSOFT_CLIENT_SECRET',
  },
];

export function loadOidcProviders(): OidcProviderConfig[] {
  const base = process.env.AGENTLEDGER_OIDC_REDIRECT_BASE ?? 'http://localhost:8094';
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
