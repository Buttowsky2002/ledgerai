function dayAfter(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Day after portal coverage ends — API sync should start here. */
export function resolveFirstSyncBaseline(
  portalImportThrough: string | null,
  syncEndDay: string,
): string {
  if (portalImportThrough) return dayAfter(portalImportThrough);
  return dayAfter(syncEndDay);
}

/** Resolve API sync window respecting portal handoff baseline (T₀). */
export function resolveConnectorSyncRange(
  range: { from?: string; to?: string } | undefined,
  config: Record<string, unknown>,
): { from?: string; to?: string } {
  const today = new Date().toISOString().slice(0, 10);
  const baseline =
    typeof config.apiSyncBaselineFrom === 'string' ? config.apiSyncBaselineFrom.slice(0, 10) : undefined;

  if (range?.from && range?.to) {
    let from = range.from.slice(0, 10);
    const to = range.to.slice(0, 10);
    if (baseline && from < baseline) from = baseline;
    return { from, to };
  }

  if (baseline) {
    return { from: baseline, to: today };
  }

  return range ?? {};
}

export function readConnectorHandoff(config: unknown): {
  portalImportThrough: string | null;
  apiSyncBaselineFrom: string | null;
} {
  const cfg = (config ?? {}) as Record<string, unknown>;
  return {
    portalImportThrough:
      typeof cfg.portalImportThrough === 'string' ? cfg.portalImportThrough.slice(0, 10) : null,
    apiSyncBaselineFrom:
      typeof cfg.apiSyncBaselineFrom === 'string' ? cfg.apiSyncBaselineFrom.slice(0, 10) : null,
  };
}
