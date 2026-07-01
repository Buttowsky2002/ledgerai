/**
 * Resolve a secret *reference* to its value. A ref is a name — an env-var name or an
 * AWS Secrets Manager secret name — never the secret itself (rules 1 + 9). This is the
 * same convention as tenant_idp_config.client_secret_ref, connectors.secret_ref, and
 * the gateway's api_key_env.
 *
 * Resolution order:
 *   1. Environment variable (default; always works locally + in docker-compose).
 *   2. AWS Secrets Manager (opt-in via BADGERIQ_SM_ENABLED=true) — lets a new enterprise
 *      customer's OIDC client secret be added without a redeploy-per-tenant env var.
 *
 * The AWS SDK is lazy-imported so it is only loaded when SM is actually enabled, and SM
 * hits are cached in-process for 5 minutes so a busy login loop doesn't hammer the API
 * (rule 12 — no unnecessary I/O; the cache is in-process, no Redis). See ADR-049.
 */
import { env } from '../env';

const SM_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: string; exp: number }>();

/** Test seam: drop the in-process SM cache. */
export function _clearSecretCache(): void {
  cache.clear();
}

export async function resolveSecret(ref: string): Promise<string> {
  // Env-var path (default). BADGERIQ_*/LEDGERAI_*/AGENTLEDGER_* aliasing applies for
  // prefixed refs; a bare name (e.g. ACME_OIDC_SECRET) is read directly.
  const fromEnv = env(ref);
  if (fromEnv) return fromEnv;

  // AWS Secrets Manager path (opt-in).
  if (env('BADGERIQ_SM_ENABLED') !== 'true') {
    throw new Error(`Secret ref '${ref}' not found in env and SM is disabled`);
  }

  const now = Date.now();
  const hit = cache.get(ref);
  if (hit && hit.exp > now) return hit.value;

  // Lazy import: @aws-sdk/client-secrets-manager only loads when SM is enabled.
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: env('AWS_REGION') ?? 'us-east-1' });
  const res = await client.send(new GetSecretValueCommand({ SecretId: ref }));
  if (!res.SecretString) throw new Error(`Secret '${ref}' has no string value`);

  cache.set(ref, { value: res.SecretString, exp: now + SM_TTL_MS });
  return res.SecretString;
}
