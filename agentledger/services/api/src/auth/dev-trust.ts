/**
 * Dev-only "trust the x-tenant-id header" auth shim.
 *
 * This bypasses real login so local dev and the tenant-isolation suite can run
 * without a live IdP. It MUST never be reachable in production. Two independent
 * layers enforce that:
 *
 *  1. shouldTrustDevTenantHeader() is hard-gated on isProductionEnv(), so the
 *     middleware never trusts the header in prod even if the flag is set.
 *  2. assertDevTrustHeaderNotInProduction() fails startup when the flag is set in
 *     production, so a misconfiguration cannot silently ship.
 *
 * Production is detected via env('BADGERIQ_ENV') (and LEDGERAI_/AGENTLEDGER_
 * aliases used in ECS task definitions) OR NODE_ENV === 'production'. Checking
 * only process.env.BADGERIQ_ENV would miss the alias path.
 *
 * The flag is read with explicit OR semantics across the current and deprecated
 * names — if *either* is 'true' the shim is considered requested (fail-safe: a
 * leftover legacy var can never be silently ignored by the production guard).
 */

import { env } from '../env';

/**
 * True when the process is treated as production for auth safety.
 * Prefers BADGERIQ_ENV (alias-aware via env()); NODE_ENV remains a second gate.
 */
export function isProductionEnv(): boolean {
  const named = (env('BADGERIQ_ENV') ?? '').trim().toLowerCase();
  if (named === 'production' || named === 'prod') {
    return true;
  }
  return process.env.NODE_ENV === 'production';
}

/** True if the current or a deprecated dev-trust flag is set to 'true'. */
export function devTrustHeaderRequested(): boolean {
  return env('BADGERIQ_DEV_TRUST_HEADER') === 'true';
}

/** The dev x-tenant-id header is trusted only outside production and when requested. */
export function shouldTrustDevTenantHeader(): boolean {
  return !isProductionEnv() && devTrustHeaderRequested();
}

/**
 * Fatal startup guard: refuse to boot in production with dev tenant-header auth
 * enabled. Throwing here makes a production bypass impossible — the process never
 * starts serving traffic.
 */
export function assertDevTrustHeaderNotInProduction(): void {
  if (isProductionEnv() && devTrustHeaderRequested()) {
    throw new Error(
      'FATAL: dev tenant-header auth is enabled in production ' +
        '(BADGERIQ_DEV_TRUST_HEADER / LEDGERAI_DEV_TRUST_HEADER / AGENTLEDGER_DEV_TRUST_HEADER === "true"). ' +
        'This bypasses authentication and must never run in production — refusing to start. ' +
        'Production is detected via BADGERIQ_ENV (or aliases) / NODE_ENV.',
    );
  }
}

// Canonical 8-4-4-4-12 hex UUID. Any version is accepted (tenant ids are minted
// with crypto.randomUUID(), i.e. v4, but we don't reject other valid UUIDs).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True if `value` is a well-formed UUID — used to vet the dev x-tenant-id header. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
