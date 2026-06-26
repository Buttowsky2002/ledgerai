import { BadRequestException } from '@nestjs/common';

const MAX_RANGE_DAYS = 31;

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function parseDay(iso: string, label: string): Date {
  const d = utcDayStart(new Date(`${iso}T00:00:00.000Z`));
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${label} is not a valid date`);
  return d;
}

/** Resolve inclusive UTC day window for connector preview/sync (Anthropic caps at 31 days). */
export function resolveSyncWindow(from?: string, to?: string, defaultDays = 30): { syncStart: Date; syncEnd: Date } {
  const syncEnd = to ? parseDay(to, 'to') : utcDayStart(new Date());
  const syncStart = from
    ? parseDay(from, 'from')
    : new Date(syncEnd.getTime() - (defaultDays - 1) * 86_400_000);

  if (syncStart > syncEnd) {
    throw new BadRequestException('from must be on or before to');
  }

  const spanDays = Math.floor((syncEnd.getTime() - syncStart.getTime()) / 86_400_000) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new BadRequestException(`date range cannot exceed ${MAX_RANGE_DAYS} days (Anthropic API limit)`);
  }

  return { syncStart, syncEnd };
}
