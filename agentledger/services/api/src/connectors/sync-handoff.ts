function dayAfter(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** UTC day before an ISO date (for handoff messaging). */
export function dayBeforeIso(isoDay: string): string {
  const d = new Date(`${isoDay.slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
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

/**
 * Whether a completed sync window is large enough to lock apiSyncBaselineFrom.
 * Short incremental/manual windows must not freeze history (pilot bug: 3-day
 * sync set baseline and blocked the 90-day Cursor backfill forever).
 */
export function shouldLockApiSyncBaseline(opts: {
  portalImportThrough: string | null;
  coveredDays: number;
  defaultBackfillDays: number;
}): boolean {
  if (opts.portalImportThrough) return true;
  // Allow a day of slack for timezone / inclusive-range edge cases.
  return opts.coveredDays >= Math.max(1, opts.defaultBackfillDays - 1);
}

export type SyncRangeResolution = { from?: string; to?: string };

export interface ResolveConnectorSyncRangeOptions {
  /** Background scheduler — skip when the window is already covered by handoff baseline. */
  incremental?: boolean;
}

/** Resolve API sync window respecting portal handoff baseline (T₀). */
export function resolveConnectorSyncRange(
  range: { from?: string; to?: string } | undefined,
  config: Record<string, unknown>,
  opts?: ResolveConnectorSyncRangeOptions,
): SyncRangeResolution | null {
  const today = new Date().toISOString().slice(0, 10);
  const baseline =
    typeof config.apiSyncBaselineFrom === 'string' ? config.apiSyncBaselineFrom.slice(0, 10) : undefined;

  if (range?.from && range?.to) {
    const origFrom = range.from.slice(0, 10);
    let from = origFrom;
    const to = range.to.slice(0, 10);

    // Entire requested window ends before API handoff — allow manual re-backfill, skip incremental.
    if (baseline && to < baseline) {
      if (opts?.incremental) return null;
      return { from: origFrom, to };
    }

    if (baseline && from < baseline) from = baseline;
    if (from > to) {
      if (opts?.incremental) return null;
      return { from: origFrom, to };
    }
    return { from, to };
  }

  if (baseline) {
    if (baseline > today) {
      if (opts?.incremental) return null;
      return { from: baseline, to: baseline };
    }
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
