/** Provider APIs (Anthropic) cap each request at 31 inclusive days. */
export const MAX_SYNC_DAYS = 31;

function parseUtcDay(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
}

function formatUtcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function spanDaysInclusive(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
}

/** Split an inclusive UTC date range into chunks of at most maxDays (default 31). */
export function syncDateChunks(
  from: string,
  to: string,
  maxDays = MAX_SYNC_DAYS,
): { from: string; to: string }[] {
  const start = parseUtcDay(from);
  const end = parseUtcDay(to);
  if (start > end) return [];

  const chunks: { from: string; to: string }[] = [];
  let chunkEnd = end;

  while (chunkEnd >= start) {
    const chunkStart = new Date(
      Math.max(start.getTime(), chunkEnd.getTime() - (maxDays - 1) * 86_400_000),
    );
    chunks.unshift({ from: formatUtcDay(chunkStart), to: formatUtcDay(chunkEnd) });
    if (chunkStart.getTime() <= start.getTime()) break;
    chunkEnd = new Date(chunkStart.getTime() - 86_400_000);
  }

  return chunks;
}

/** Most recent maxDays window within the selected range (for Test preview). */
export function previewDateRange(from: string, to: string, maxDays = MAX_SYNC_DAYS): { from: string; to: string } {
  const chunks = syncDateChunks(from, to, maxDays);
  return chunks[chunks.length - 1] ?? { from, to };
}

export function syncBatchCount(from: string, to: string): number {
  return syncDateChunks(from, to).length;
}

export function rangeSpanDays(from: string, to: string): number {
  return spanDaysInclusive(parseUtcDay(from), parseUtcDay(to));
}
