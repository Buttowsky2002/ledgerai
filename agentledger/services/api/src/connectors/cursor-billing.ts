export type CursorBillingKind = 'on_demand' | 'included' | 'errored';

export function classifyCursorBillingKind(
  kind: string,
  isChargeable?: boolean,
): CursorBillingKind {
  const k = kind.trim().toLowerCase();
  if (!k && isChargeable === true) return 'on_demand';
  if (!k && isChargeable === false) return 'included';
  if (k.includes('error')) return 'errored';
  if (k.includes('on-demand') || k.includes('usage-based')) return 'on_demand';
  if (k.includes('included')) return 'included';
  if (isChargeable === true) return 'on_demand';
  if (isChargeable === false) return 'included';
  return 'included';
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Split Cursor chargedCents cost into billed overage vs subscription usage value. */
export function enrichCursorBilling(metrics: Record<string, unknown>): Record<string, unknown> {
  if (String(metrics.provider ?? '').toLowerCase() !== 'cursor') return metrics;

  const usageValueUsd = num(metrics.cost_usd);
  const kind = classifyCursorBillingKind(
    String(metrics.product ?? metrics.kind ?? ''),
    metrics.is_chargeable as boolean | undefined,
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
