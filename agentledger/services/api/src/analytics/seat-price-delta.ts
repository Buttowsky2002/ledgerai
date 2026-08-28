/** Seat-license cost ≈ seats × unit. Split a $ change into volume vs rate. */

export type SeatSnapshot = {
  seats: number;
  unitCostUsd: number;
  costUsd: number;
};

export type SeatPriceDelta = {
  seatDelta: number;
  usdDelta: number;
  usdFromSeats: number;
  usdFromRate: number;
  prior: SeatSnapshot | null;
  current: SeatSnapshot;
};

export type FixedCostSeatRow = {
  period_month: string;
  vendor: string;
  seats: unknown;
  unit_cost_usd: unknown;
  cost_usd: unknown;
};

export type VendorSeatChange = {
  vendor: string;
  seats: number;
  prior_seats: number | null;
  usd_from_seats: number;
  usd_from_rate: number;
  prior_period_month: string | null;
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function monthStart(iso: string): string {
  return `${String(iso).slice(0, 7)}-01`;
}

/** First day of the calendar month before `periodMonth` (YYYY-MM-01). */
export function previousCalendarMonth(periodMonth: string): string {
  const y = Number(periodMonth.slice(0, 4));
  const m = Number(periodMonth.slice(5, 7));
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Per-seat unit: stored unit_cost_usd, else cost / seats (enterprise contracts). */
export function resolveUnitCost(snapshot: SeatSnapshot): number {
  const unit = n(snapshot.unitCostUsd);
  if (unit > 0) {return unit;}
  const seats = n(snapshot.seats);
  const cost = n(snapshot.costUsd);
  if (seats > 0 && cost > 0) {return cost / seats;}
  return 0;
}

/**
 * Volume effect at the prior unit price. New rows (no prior) treat the full
 * total as from seats.
 */
export function seatPriceDelta(current: SeatSnapshot, prior: SeatSnapshot | null): SeatPriceDelta {
  const curr: SeatSnapshot = {
    seats: Math.max(0, n(current.seats)),
    unitCostUsd: n(current.unitCostUsd),
    costUsd: n(current.costUsd),
  };
  if (!prior) {
    return {
      seatDelta: curr.seats,
      usdDelta: round2(curr.costUsd),
      usdFromSeats: round2(curr.costUsd),
      usdFromRate: 0,
      prior: null,
      current: curr,
    };
  }
  const prev: SeatSnapshot = {
    seats: Math.max(0, n(prior.seats)),
    unitCostUsd: n(prior.unitCostUsd),
    costUsd: n(prior.costUsd),
  };
  const oldUnit = resolveUnitCost(prev);
  const seatDelta = curr.seats - prev.seats;
  const usdDelta = round2(curr.costUsd - prev.costUsd);
  const usdFromSeats = round2(seatDelta * oldUnit);
  return {
    seatDelta,
    usdDelta,
    usdFromSeats,
    usdFromRate: round2(usdDelta - usdFromSeats),
    prior: prev,
    current: curr,
  };
}

function snapshotForRows(rows: FixedCostSeatRow[]): SeatSnapshot | null {
  if (rows.length === 0) {return null;}
  const seats = rows.reduce((s, r) => s + n(r.seats), 0);
  const costUsd = round2(rows.reduce((s, r) => s + n(r.cost_usd), 0));
  const units = rows
    .map((r) =>
      resolveUnitCost({
        seats: n(r.seats),
        unitCostUsd: n(r.unit_cost_usd),
        costUsd: n(r.cost_usd),
      }),
    )
    .filter((u) => u > 0)
    .map((u) => round2(u));
  const unique = [...new Set(units)];
  const unitCostUsd = unique.length === 1 ? unique[0] : seats > 0 ? round2(costUsd / seats) : 0;
  return { seats, unitCostUsd, costUsd };
}

/**
 * Per vendor: latest billing month overlapping [from, to] vs the previous
 * calendar month. Seat-change $ is monthly run-rate, not prorated.
 */
export function vendorSeatChanges(
  rows: FixedCostSeatRow[],
  from: string,
  to: string,
): { latestMonth: string | null; changes: Record<string, VendorSeatChange> } {
  const rangeStart = monthStart(from);
  const rangeEnd = monthStart(to);
  const byVendor = new Map<string, FixedCostSeatRow[]>();
  for (const row of rows) {
    const vendor = String(row.vendor ?? '').trim().toLowerCase() || 'other';
    const list = byVendor.get(vendor) ?? [];
    list.push(row);
    byVendor.set(vendor, list);
  }

  let latestMonth: string | null = null;
  const changes: Record<string, VendorSeatChange> = {};

  for (const [vendor, vendorRows] of byVendor) {
    const inRange = vendorRows.filter((r) => {
      const m = monthStart(String(r.period_month));
      return m >= rangeStart && m <= rangeEnd;
    });
    if (inRange.length === 0) {continue;}
    const vendorLatest = inRange.reduce((max, r) => {
      const m = monthStart(String(r.period_month));
      return m > max ? m : max;
    }, monthStart(String(inRange[0].period_month)));
    if (!latestMonth || vendorLatest > latestMonth) {latestMonth = vendorLatest;}

    const priorMonth = previousCalendarMonth(vendorLatest);
    const current = snapshotForRows(
      vendorRows.filter((r) => monthStart(String(r.period_month)) === vendorLatest),
    );
    if (!current) {continue;}
    const prior = snapshotForRows(
      vendorRows.filter((r) => monthStart(String(r.period_month)) === priorMonth),
    );
    // No prior month → not a seat *change* (avoid treating the full bill as a delta).
    if (!prior) {
      changes[vendor] = {
        vendor,
        seats: current.seats,
        prior_seats: null,
        usd_from_seats: 0,
        usd_from_rate: 0,
        prior_period_month: null,
      };
      continue;
    }
    const delta = seatPriceDelta(current, prior);
    const seatsChanged = delta.seatDelta !== 0;
    changes[vendor] = {
      vendor,
      seats: current.seats,
      prior_seats: prior.seats,
      usd_from_seats: seatsChanged ? delta.usdFromSeats : 0,
      usd_from_rate: seatsChanged ? 0 : delta.usdFromRate,
      prior_period_month: priorMonth,
    };
  }

  return { latestMonth, changes };
}
