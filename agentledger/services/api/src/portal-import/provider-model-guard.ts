/**
 * Boundary check: does a billing CSV's model vocabulary match the provider the
 * operator selected for it?
 *
 * Portal imports are stamped with a provider chosen in the UI, not one proven
 * by the file. A Cursor team-usage export stamped `anthropic` books spend
 * against a vendor the tenant may have no account with, and the per-provider
 * reconciler cannot collapse those rows against the Cursor connector's own
 * rows — so the same charges land in provider-level totals twice.
 *
 * These patterns are deliberately high-precision: they fire only on slugs that
 * no other vendor's billing export can legitimately contain, because a false
 * rejection blocks a real import. Detecting "claude" in a model name proves
 * nothing (Cursor resells Claude), so only Cursor-exclusive markers count.
 */

/** Models sold only by Cursor, plus the pseudo-models its usage report emits. */
const CURSOR_EXCLUSIVE_MODELS: RegExp[] = [
  /^composer(?:$|[-_.\s])/,
  /^agent_review$/,
  /^auto$/,
  /^default$/,
  /^premium$/,
];

/**
 * Cursor annotates models with a reasoning-effort tier. Provider billing
 * exports identify models by API id (`claude-sonnet-4-20250514`) and never
 * carry an effort annotation.
 */
const CURSOR_EFFORT_ANNOTATION = /(?:^|[-_])thinking(?:[-_]|$)|[-_](?:xhigh|xlow)(?:$|[-_])/;

export type ProviderModelConflict = { model: string; reason: string };

function normalizeModel(model: unknown): string {
  return String(model ?? '').trim().toLowerCase();
}

/**
 * Why this model could only have come from Cursor, or null when it is
 * consistent with any vendor.
 */
export function cursorOnlyModelReason(model: unknown): string | null {
  const m = normalizeModel(model);
  if (!m) {return null;}
  if (CURSOR_EXCLUSIVE_MODELS.some((re) => re.test(m))) {
    return 'sold only by Cursor';
  }
  if (CURSOR_EFFORT_ANNOTATION.test(m)) {
    return "carries Cursor's reasoning-effort annotation";
  }
  return null;
}

/**
 * Distinct models in `models` that contradict `provider`, capped at `limit` so
 * an error message stays readable.
 */
export function detectProviderModelConflicts(
  provider: string,
  models: Iterable<unknown>,
  limit = 5,
): ProviderModelConflict[] {
  const target = normalizeModel(provider);
  if (!target || target === 'cursor') {return [];}

  const conflicts: ProviderModelConflict[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    const model = normalizeModel(raw);
    if (!model || seen.has(model)) {continue;}
    seen.add(model);
    const reason = cursorOnlyModelReason(model);
    if (reason) {conflicts.push({ model, reason });}
    if (conflicts.length >= limit) {break;}
  }
  return conflicts;
}

/** Operator-facing explanation naming the offending models and the likely fix. */
export function providerModelConflictMessage(
  provider: string,
  conflicts: ProviderModelConflict[],
): string {
  const detail = conflicts.map((c) => `${c.model} (${c.reason})`).join(', ');
  return (
    `this file looks like a Cursor export but was stamped as "${provider}": ${detail}. ` +
    'Re-import with Cursor as the billing provider, or correct the file — importing ' +
    'it under the wrong provider double-counts the same spend in per-provider totals.'
  );
}
