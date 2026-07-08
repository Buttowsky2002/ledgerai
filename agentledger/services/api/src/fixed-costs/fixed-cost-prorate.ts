const MS_DAY = 86_400_000;

function parseUtcDate(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
}

/** Calendar days in the billing month (UTC). */
export function daysInBillingMonth(periodMonth: string): number {
  const monthStart = parseUtcDate(`${periodMonth.slice(0, 7)}-01`);
  const year = monthStart.getUTCFullYear();
  const month = monthStart.getUTCMonth();
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Days of [from, to] that fall inside the billing month (inclusive). */
export function overlapDaysInBillingMonth(periodMonth: string, from: string, to: string): number {
  const monthStart = parseUtcDate(`${periodMonth.slice(0, 7)}-01`);
  const dim = daysInBillingMonth(periodMonth);
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), dim));
  const rangeStart = parseUtcDate(from);
  const rangeEnd = parseUtcDate(to);
  const start = rangeStart > monthStart ? rangeStart : monthStart;
  const end = rangeEnd < monthEnd ? rangeEnd : monthEnd;
  if (end < start) return 0;
  return Math.floor((end.getTime() - start.getTime()) / MS_DAY) + 1;
}

/** Prorate a monthly subscription/seat charge to the selected date range. */
export function prorateMonthlyCost(
  monthlyUsd: number,
  periodMonth: string,
  from: string,
  to: string,
): number {
  const dim = daysInBillingMonth(periodMonth);
  const overlap = overlapDaysInBillingMonth(periodMonth, from, to);
  if (monthlyUsd <= 0 || dim <= 0 || overlap <= 0) return 0;
  return Math.round(((monthlyUsd * overlap) / dim) * 100) / 100;
}

export function sumProratedMonthlyCosts(
  rows: { period_month: string; cost_usd: number }[],
  from: string,
  to: string,
): number {
  const total = rows.reduce(
    (s, row) => s + prorateMonthlyCost(Number(row.cost_usd), String(row.period_month), from, to),
    0,
  );
  return Math.round(total * 100) / 100;
}
