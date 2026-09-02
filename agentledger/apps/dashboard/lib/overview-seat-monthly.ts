/** Fixed-cost row shape used for monthly seat run-rate on Overview. */
export type FixedCostSeatRow = {
  vendor?: string | null;
  period_month?: string | null;
  cost_usd?: number | string | null;
  seats?: number | string | null;
  line_item?: string | null;
  cost_type?: string | null;
};

function monthKey(iso: string): string {
  return iso.slice(0, 7);
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

/** Latest billing month in the selected range (used for /mo run-rate display). */
export function latestBillingMonthInRange(from: string, to: string): string {
  const months = billingMonthsInRange(from, to);
  return months.length > 0 ? months[months.length - 1]! : monthKey(to);
}

/** Sum monthly seat $ for one billing month from admin fixed_costs rows. */
export function monthlySeatTotalForMonth(
  rows: FixedCostSeatRow[],
  billingMonth: string,
): number {
  const prefix = billingMonth.slice(0, 7);
  const total = rows.reduce((s, row) => {
    if (monthKey(String(row.period_month ?? '')) !== prefix) {
      return s;
    }
    return s + Number(row.cost_usd ?? 0);
  }, 0);
  return Math.round(total * 100) / 100;
}

/** Per-vendor monthly seat $ + seats for one billing month. */
export function monthlySeatByVendorForMonth(
  rows: FixedCostSeatRow[],
  billingMonth: string,
): Map<string, { seat_usd: number; seats: number }> {
  const prefix = billingMonth.slice(0, 7);
  const out = new Map<string, { seat_usd: number; seats: number }>();
  for (const row of rows) {
    if (monthKey(String(row.period_month ?? '')) !== prefix) {
      continue;
    }
    const vendor = String(row.vendor ?? 'other')
      .trim()
      .toLowerCase();
    const cur = out.get(vendor) ?? { seat_usd: 0, seats: 0 };
    cur.seat_usd += Number(row.cost_usd ?? 0);
    cur.seats += Number(row.seats ?? 0);
    out.set(vendor, cur);
  }
  for (const [vendor, v] of out) {
    out.set(vendor, {
      seat_usd: Math.round(v.seat_usd * 100) / 100,
      seats: v.seats,
    });
  }
  return out;
}

/** Total subscription $ for all billing months in range (period total). */
export function periodSeatTotal(rows: FixedCostSeatRow[], from: string, to: string): number {
  const total = billingMonthsInRange(from, to).reduce(
    (s, month) => s + monthlySeatTotalForMonth(rows, month),
    0,
  );
  return Math.round(total * 100) / 100;
}

function vendorName(row: FixedCostSeatRow): string {
  return String(row.vendor ?? 'other')
    .trim()
    .toLowerCase();
}

/** One subscription line (Team vs Max, seat vs enterprise) — carried independently. */
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
    const month = monthKey(String(row.period_month ?? ''));
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
 * Latest configured monthly seat charge per vendor on or before `billingMonth`.
 * Each plan line (vendor + cost_type + line_item) carries forward independently,
 * then sums to one vendor total — adding Claude Max in September does not drop
 * Claude Team seats recorded in July.
 */
export function latestSeatByVendorOnOrBefore(
  rows: FixedCostSeatRow[],
  billingMonth: string,
): Map<string, { seat_usd: number; seats: number; period_month: string }> {
  return sumLineItemsByVendor(rows, billingMonth);
}

/** Monthly run-rate: sum of latest seat config per vendor as of range end. */
export function monthlySeatRunRateAsOf(rows: FixedCostSeatRow[], asOf: string): number {
  const asOfMonth = monthKey(asOf);
  const total = [...latestSeatByVendorOnOrBefore(rows, asOfMonth).values()].reduce(
    (s, v) => s + v.seat_usd,
    0,
  );
  return Math.round(total * 100) / 100;
}

/**
 * Period subscription total: for each billing month in range, bill each vendor's
 * latest configured monthly rate on or before that month (full month, not prorated).
 */
export function periodSeatTotalWithCarryForward(
  rows: FixedCostSeatRow[],
  from: string,
  to: string,
): number {
  const total = billingMonthsInRange(from, to).reduce(
    (s, month) => s + monthlySeatRunRateAsOf(rows, `${month}-28`),
    0,
  );
  return Math.round(total * 100) / 100;
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

export type SeatEntrySnapshot = {
  period_month: string;
  seats: number;
  unit_cost_usd: number;
  cost_usd: number;
};

/**
 * Latest admin row for a vendor/plan strictly before a billing month — used to pre-fill
 * seats and unit price when recording a new month.
 */
export function priorSeatEntryForVendor(
  rows: Array<
    FixedCostSeatRow & { line_item?: string | null; cost_type?: string | null; unit_cost_usd?: number | string | null }
  >,
  vendor: string,
  opts?: { beforeMonth?: string; lineItem?: string; costType?: string },
): SeatEntrySnapshot | null {
  const vendorKey = vendor.trim().toLowerCase();
  const before = opts?.beforeMonth?.slice(0, 7);
  let bestMonth = '';
  let best: SeatEntrySnapshot | null = null;

  for (const row of rows) {
    if (String(row.vendor ?? '').trim().toLowerCase() !== vendorKey) {
      continue;
    }
    if (opts?.lineItem != null && String(row.line_item ?? '') !== opts.lineItem) {
      continue;
    }
    if (opts?.costType != null && String(row.cost_type ?? '') !== opts.costType) {
      continue;
    }
    const month = monthKey(String(row.period_month ?? ''));
    if (!month || (before && month >= before)) {
      continue;
    }
    if (month > bestMonth) {
      bestMonth = month;
      best = {
        period_month: `${month}-01`,
        seats: Number(row.seats ?? 0),
        unit_cost_usd: Number(row.unit_cost_usd ?? 0),
        cost_usd: Number(row.cost_usd ?? 0),
      };
    }
  }
  return best;
}

/** Latest monthly $ per vendor (not summed across billing months in range). */
export function latestMonthlyTotalsByVendor(
  rows: FixedCostSeatRow[],
): { vendor: string; total: number }[] {
  return [...latestSeatByVendor(rows).entries()]
    .map(([vendor, snap]) => ({ vendor, total: snap.seat_usd }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Fixed subscription $ attributed to [from, to]: one full monthly charge per billing
 * month in range at each vendor's latest config on or before that month; for a
 * single-month range, uses current monthly run-rate (matches admin overhead).
 */
export function periodSeatTotalForRange(rows: FixedCostSeatRow[], from: string, to: string): number {
  const months = billingMonthsInRange(from, to);
  if (months.length === 1) {
    return currentMonthlySeatRunRate(rows);
  }
  return periodSeatTotalWithCarryForward(rows, from, to);
}
