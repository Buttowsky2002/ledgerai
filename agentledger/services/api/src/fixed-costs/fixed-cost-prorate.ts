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
  if (end < start) {
    return 0;
  }
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
  if (monthlyUsd <= 0 || dim <= 0 || overlap <= 0) {
    return 0;
  }
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

/** Sum full monthly seat charges from fixed_costs rows (no day proration within a month). */
export function sumMonthlySeatCosts(rows: { cost_usd: number }[]): number {
  const total = rows.reduce((s, row) => s + Number(row.cost_usd ?? 0), 0);
  return Math.round(total * 100) / 100;
}

export type FixedCostSeatRow = {
  period_month: string;
  vendor?: string | null;
  cost_usd: number;
  seats?: number | null;
  line_item?: string | null;
  cost_type?: string | null;
};

function monthKey(iso: string): string {
  return String(iso).slice(0, 7);
}

function vendorName(row: FixedCostSeatRow): string {
  return String(row.vendor ?? 'other')
    .trim()
    .toLowerCase();
}

function lineItemKey(row: FixedCostSeatRow): string {
  return `${vendorName(row)}\0${String(row.cost_type ?? '').trim()}\0${String(row.line_item ?? '').trim()}`;
}

function sumLineItemsByVendor(
  rows: FixedCostSeatRow[],
  billingMonth: string,
): Map<string, { seat_usd: number; seats: number; period_month: string }> {
  const limit = billingMonth.slice(0, 7);
  const best = new Map<string, { vendor: string; month: string; seat_usd: number; seats: number }>();
  for (const row of rows) {
    const month = monthKey(row.period_month);
    if (!month || month > limit) {
      continue;
    }
    const vendor = vendorName(row);
    const key = lineItemKey(row);
    const prev = best.get(key);
    if (prev && prev.month > month) {
      continue;
    }
    if (prev && prev.month === month) {
      prev.seat_usd += Number(row.cost_usd ?? 0);
      prev.seats += Number(row.seats ?? 0);
      continue;
    }
    best.set(key, {
      vendor,
      month,
      seat_usd: Number(row.cost_usd ?? 0),
      seats: Number(row.seats ?? 0),
    });
  }

  const out = new Map<string, { seat_usd: number; seats: number; period_month: string }>();
  for (const snap of best.values()) {
    const cur = out.get(snap.vendor) ?? { seat_usd: 0, seats: 0, period_month: `${snap.month}-01` };
    cur.seat_usd += snap.seat_usd;
    cur.seats += snap.seats;
    if (snap.month > cur.period_month.slice(0, 7)) {
      cur.period_month = `${snap.month}-01`;
    }
    out.set(snap.vendor, cur);
  }
  for (const [vendor, v] of out) {
    if (v.seat_usd <= 0 && v.seats <= 0) {
      out.delete(vendor);
      continue;
    }
    out.set(vendor, {
      seat_usd: Math.round(v.seat_usd * 100) / 100,
      seats: v.seats,
      period_month: v.period_month,
    });
  }
  return out;
}

/**
 * Each plan line carries forward independently, then sums to one vendor total.
 * Adding a new Anthropic plan does not drop earlier Anthropic seat lines.
 */
export function latestSeatByVendorOnOrBefore(
  rows: FixedCostSeatRow[],
  billingMonth: string,
): Map<string, { seat_usd: number; seats: number; period_month: string }> {
  return sumLineItemsByVendor(rows, billingMonth);
}

/** Current monthly seat charge per vendor: every plan line carried forward, then summed. */
export function latestSeatByVendor(
  rows: FixedCostSeatRow[],
): Map<string, { seat_usd: number; seats: number; period_month: string }> {
  return latestSeatByVendorOnOrBefore(rows, '9999-12');
}

/** Current monthly run-rate from admin seat config (all vendors, latest billing month). */
export function currentMonthlySeatRunRate(rows: FixedCostSeatRow[]): number {
  const total = [...latestSeatByVendor(rows).values()].reduce((s, v) => s + v.seat_usd, 0);
  return Math.round(total * 100) / 100;
}

/** Billing months (YYYY-MM) overlapping [from, to], sorted ascending. */
export function billingMonthsInRange(from: string, to: string): string[] {
  const start = monthKey(from);
  const end = monthKey(to);
  const months: string[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const endY = Number(end.slice(0, 4));
  const endM = Number(end.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

function monthlySeatRunRateAsOf(rows: FixedCostSeatRow[], asOf: string): number {
  const total = [...latestSeatByVendorOnOrBefore(rows, monthKey(asOf)).values()].reduce(
    (s, v) => s + v.seat_usd,
    0,
  );
  return Math.round(total * 100) / 100;
}

function periodSeatTotalWithCarryForward(rows: FixedCostSeatRow[], from: string, to: string): number {
  const total = billingMonthsInRange(from, to).reduce(
    (s, month) => s + monthlySeatRunRateAsOf(rows, `${month}-28`),
    0,
  );
  return Math.round(total * 100) / 100;
}

/**
 * Fixed subscription $ attributed to [from, to]: one full monthly charge per billing
 * month in range at each vendor's latest config; single-month ranges use current run-rate.
 */
export function periodSeatTotalForRange(rows: FixedCostSeatRow[], from: string, to: string): number {
  const months = billingMonthsInRange(from, to);
  if (months.length === 1) {
    return currentMonthlySeatRunRate(rows);
  }
  return periodSeatTotalWithCarryForward(rows, from, to);
}

/** ISO date `lookbackMonths` before `to` (for fixed-cost history fetch). */
export function seatLookupFromDate(to: string, lookbackMonths = 24): string {
  const y = Number(to.slice(0, 4));
  const m = Number(to.slice(5, 7));
  const d = new Date(Date.UTC(y, m - 1 - lookbackMonths, 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Upper bound for seat-config history: never cut off at a past range end, so the
 * latest admin seats/price persist on every Overview date filter.
 */
export function seatLookupToDate(to: string, today = new Date()): string {
  const todayIso = today.toISOString().slice(0, 10);
  return to.slice(0, 10) >= todayIso ? to.slice(0, 10) : todayIso;
}

/** Project fixed seat licenses across a forecast horizon (monthly run-rate × months). */
export function forecastFixedSeatCost(monthlyRunRateUsd: number, forecastDays: number): number {
  if (monthlyRunRateUsd <= 0 || forecastDays <= 0) {
    return 0;
  }
  return Math.round(monthlyRunRateUsd * (forecastDays / 30.437) * 100) / 100;
}
