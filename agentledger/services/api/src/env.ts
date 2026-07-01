/**
 * Environment-variable resolution with backwards-compatible aliasing.
 *
 * Prefer the `BADGERIQ_*` prefix. If unset, we fall back to the deprecated
 * `LEDGERAI_*` and legacy `AGENTLEDGER_*` aliases so existing deployments
 * keep working. See the "Renaming to BadgerIQ" note in the repo README.
 */
const ENV_PREFIXES = ['BADGERIQ_', 'LEDGERAI_', 'AGENTLEDGER_'] as const;

function envSuffix(name: string): string | null {
  for (const prefix of ENV_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return null;
}

export function env(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined && direct !== '') {
    return direct;
  }
  const suffix = envSuffix(name);
  if (!suffix) return direct;
  for (const prefix of ENV_PREFIXES) {
    const key = prefix + suffix;
    if (key === name) continue;
    const val = process.env[key];
    if (val !== undefined && val !== '') {
      return val;
    }
  }
  return direct;
}
