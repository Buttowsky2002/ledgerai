/**
 * Environment-variable resolution with backwards-compatible aliasing.
 *
 * The project is being rebranded from AgentLedger to LedgerAI. Call sites pass
 * the new `LEDGERAI_*` name; if it is unset we fall back to the legacy
 * `AGENTLEDGER_*` alias (deprecated — kept so existing deployments keep
 * working). See the "Renaming to LedgerAI" note in the repo README.
 */
export function env(name: string): string | undefined {
  const current = process.env[name];
  if (current !== undefined && current !== '') {
    return current;
  }
  if (name.startsWith('LEDGERAI_')) {
    const legacy = 'AGENTLEDGER_' + name.slice('LEDGERAI_'.length);
    const legacyVal = process.env[legacy];
    if (legacyVal !== undefined && legacyVal !== '') {
      return legacyVal;
    }
  }
  return current;
}
