export type CursorBillingKind = 'on_demand' | 'included' | 'errored';

/** Coerce Cursor Admin API isChargeable (boolean | string | number). */
export function coerceIsChargeable(v: unknown): boolean | undefined {
  if (v === true || v === 1) {return true;}
  if (v === false || v === 0) {return false;}
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') {return true;}
    if (s === 'false' || s === '0') {return false;}
  }
  return undefined;
}

export function classifyCursorBillingKind(
  kind: string,
  isChargeable?: boolean | unknown,
): CursorBillingKind {
  const k = kind.trim().toLowerCase().replace(/[_ ]+/g, '-');
  const chargeable = coerceIsChargeable(isChargeable);

  // Cursor documents `kind` as the billing outcome per request. Prefer it over
  // isChargeable when the two disagree — some Usage-based rows arrive with
  // isChargeable:false while still being true on-demand overage.
  if (k.includes('error') || k.includes('not-charged')) {return 'errored';}
  if (k.includes('usage-based') || k.includes('on-demand')) {return 'on_demand';}
  if (k.includes('included')) {return 'included';}

  if (chargeable === true) {return 'on_demand';}
  if (chargeable === false) {return 'included';}

  if (!k) {return 'included';}
  // Unknown kind without isChargeable — default included so we never invent invoice lines.
  return 'included';
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) {return v;}
  if (v === undefined || v === null || v === '') {return 0;}
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Split Cursor chargedCents cost into billed overage vs subscription usage value. */
export function enrichCursorBilling(metrics: Record<string, unknown>): Record<string, unknown> {
  if (String(metrics.provider ?? '').toLowerCase() !== 'cursor') {return metrics;}

  const usageValueUsd = num(metrics.cost_usd);
  const kind = classifyCursorBillingKind(
    String(metrics.product ?? metrics.kind ?? ''),
    metrics.is_chargeable ?? metrics.isChargeable,
  );
  const billedUsd = kind === 'on_demand' ? usageValueUsd : 0;

  return {
    ...metrics,
    usage_value_usd: round6(usageValueUsd),
    billed_cost_usd: round6(billedUsd),
    billing_kind: kind,
    operation_name: `cursor:${kind}`,
    cost_usd: round6(billedUsd),
    cost_source: kind === 'on_demand' ? 'cursor_billed' : 'cursor_usage_value',
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
