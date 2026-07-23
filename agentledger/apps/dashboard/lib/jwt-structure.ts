/**
 * Structural JWT checks for the dashboard soft-gate.
 *
 * Does NOT verify the signature — that remains the control-plane API's job.
 * Rejects obviously forged/malformed/expired tokens before they reach RSC.
 *
 * Edge-safe: uses atob, not Node Buffer.
 */

function base64UrlToJson(segment: string): unknown {
  const padded =
    segment.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (segment.length % 4)) % 4);
  const json = atob(padded);
  return JSON.parse(json);
}

/** True when token has three Base64url segments and a non-expired numeric exp. */
export function isStructurallyValidJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  if (!parts[0] || !parts[1] || !parts[2]) return false;
  try {
    const payload = base64UrlToJson(parts[1]);
    if (!payload || typeof payload !== 'object') return false;
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp !== 'number') return false;
    if (Date.now() / 1000 > exp) return false;
    return true;
  } catch {
    return false;
  }
}
