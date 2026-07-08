import { BadRequestException } from '@nestjs/common';

/** Max days per provider API request (Anthropic limit). Cursor uses 30 — see preset syncRange. */
export const MAX_RANGE_DAYS = 31;

/** Cursor Admin API: date range cannot exceed 30 days per request. */
export const CURSOR_MAX_RANGE_DAYS = 30;

/** Default historical backfill window for connector sync. */
export const DEFAULT_BACKFILL_DAYS = 90;

const MS_PER_DAY = 86_400_000;

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function parseDay(iso: string, label: string): Date {
  const d = utcDayStart(new Date(`${iso}T00:00:00.000Z`));
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${label} is not a valid date`);
  return d;
}

function spanDaysInclusive(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
}

/** Resolve inclusive UTC day window for a single API call. */
export function resolveSyncWindow(
  from?: string,
  to?: string,
  defaultDays = 30,
  maxDays = MAX_RANGE_DAYS,
): { syncStart: Date; syncEnd: Date } {
  const syncEnd = to ? parseDay(to, 'to') : utcDayStart(new Date());
  const syncStart = from
    ? parseDay(from, 'from')
    : new Date(syncEnd.getTime() - (defaultDays - 1) * MS_PER_DAY);

  if (syncStart > syncEnd) {
    throw new BadRequestException('from must be on or before to');
  }

  const spanDays = spanDaysInclusive(syncStart, syncEnd);
  if (spanDays > maxDays) {
    throw new BadRequestException(`date range cannot exceed ${maxDays} days (provider API limit)`);
  }

  return { syncStart, syncEnd };
}

/**
 * Clip a requested range to the most recent MAX_RANGE_DAYS for preview/test
 * (one API round-trip). Wider UI ranges are fully imported via resolveSyncChunks.
 */
export function resolvePreviewWindow(
  from?: string,
  to?: string,
  defaultDays = 30,
  maxDays = MAX_RANGE_DAYS,
): { syncStart: Date; syncEnd: Date } {
  const syncEnd = to ? parseDay(to, 'to') : utcDayStart(new Date());
  let syncStart = from
    ? parseDay(from, 'from')
    : new Date(syncEnd.getTime() - (defaultDays - 1) * MS_PER_DAY);

  if (syncStart > syncEnd) {
    throw new BadRequestException('from must be on or before to');
  }

  if (spanDaysInclusive(syncStart, syncEnd) > maxDays) {
    syncStart = new Date(syncEnd.getTime() - (maxDays - 1) * MS_PER_DAY);
  }

  return { syncStart, syncEnd };
}

/** Split a backfill window into provider-sized inclusive chunks. */
export function resolveSyncChunks(
  from?: string,
  to?: string,
  totalDays = DEFAULT_BACKFILL_DAYS,
  maxDaysPerRequest = MAX_RANGE_DAYS,
): { syncStart: Date; syncEnd: Date }[] {
  const syncEnd = to ? parseDay(to, 'to') : utcDayStart(new Date());
  const syncStart = from
    ? parseDay(from, 'from')
    : new Date(syncEnd.getTime() - (totalDays - 1) * MS_PER_DAY);

  if (syncStart > syncEnd) {
    throw new BadRequestException('from must be on or before to');
  }

  const chunks: { syncStart: Date; syncEnd: Date }[] = [];
  let chunkEnd = syncEnd;

  while (chunkEnd >= syncStart) {
    const chunkStart = new Date(
      Math.max(syncStart.getTime(), chunkEnd.getTime() - (maxDaysPerRequest - 1) * MS_PER_DAY),
    );
    chunks.unshift({ syncStart: chunkStart, syncEnd: chunkEnd });
    if (chunkStart.getTime() <= syncStart.getTime()) break;
    chunkEnd = new Date(chunkStart.getTime() - MS_PER_DAY);
  }

  return chunks;
}

/** Rolling UTC day window for scheduled (incremental) connector sync. */
export function rollingSyncWindow(days = MAX_RANGE_DAYS): { from: string; to: string } {
  const syncEnd = utcDayStart(new Date());
  const syncStart = new Date(syncEnd.getTime() - (days - 1) * MS_PER_DAY);
  return {
    from: syncStart.toISOString().slice(0, 10),
    to: syncEnd.toISOString().slice(0, 10),
  };
}

/** Default auto-sync cadence for API connectors (minutes). */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 5;

/** Short UTC window for background sync — recent days only (provider billing lag). */
export const INCREMENTAL_SYNC_DAYS = 3;

/** Narrow rolling window for live/near-live scheduled connector sync. */
export function incrementalSyncWindow(days = INCREMENTAL_SYNC_DAYS): { from: string; to: string } {
  return rollingSyncWindow(days);
}
