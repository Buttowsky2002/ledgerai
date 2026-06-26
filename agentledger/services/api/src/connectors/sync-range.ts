import { BadRequestException } from '@nestjs/common';

/** Max days per provider API request (Anthropic limit). */
export const MAX_RANGE_DAYS = 31;

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

/** Resolve inclusive UTC day window for a single API call (max 31 days). */
export function resolveSyncWindow(from?: string, to?: string, defaultDays = 30): { syncStart: Date; syncEnd: Date } {
  const syncEnd = to ? parseDay(to, 'to') : utcDayStart(new Date());
  const syncStart = from
    ? parseDay(from, 'from')
    : new Date(syncEnd.getTime() - (defaultDays - 1) * MS_PER_DAY);

  if (syncStart > syncEnd) {
    throw new BadRequestException('from must be on or before to');
  }

  const spanDays = spanDaysInclusive(syncStart, syncEnd);
  if (spanDays > MAX_RANGE_DAYS) {
    throw new BadRequestException(`date range cannot exceed ${MAX_RANGE_DAYS} days (Anthropic API limit)`);
  }

  return { syncStart, syncEnd };
}

/**
 * Clip a requested range to the most recent MAX_RANGE_DAYS for preview/test
 * (one API round-trip). Wider UI ranges are fully imported via resolveSyncChunks.
 */
export function resolvePreviewWindow(from?: string, to?: string, defaultDays = 30): { syncStart: Date; syncEnd: Date } {
  const syncEnd = to ? parseDay(to, 'to') : utcDayStart(new Date());
  let syncStart = from
    ? parseDay(from, 'from')
    : new Date(syncEnd.getTime() - (defaultDays - 1) * MS_PER_DAY);

  if (syncStart > syncEnd) {
    throw new BadRequestException('from must be on or before to');
  }

  if (spanDaysInclusive(syncStart, syncEnd) > MAX_RANGE_DAYS) {
    syncStart = new Date(syncEnd.getTime() - (MAX_RANGE_DAYS - 1) * MS_PER_DAY);
  }

  return { syncStart, syncEnd };
}

/** Split a backfill window into 31-day inclusive chunks for provider APIs. */
export function resolveSyncChunks(
  from?: string,
  to?: string,
  totalDays = DEFAULT_BACKFILL_DAYS,
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
      Math.max(syncStart.getTime(), chunkEnd.getTime() - (MAX_RANGE_DAYS - 1) * MS_PER_DAY),
    );
    chunks.unshift({ syncStart: chunkStart, syncEnd: chunkEnd });
    if (chunkStart.getTime() <= syncStart.getTime()) break;
    chunkEnd = new Date(chunkStart.getTime() - MS_PER_DAY);
  }

  return chunks;
}
