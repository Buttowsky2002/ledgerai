/** Seat-license cost ≈ seats × unit. Split a $ change into volume vs rate. */

import {
  latestSeatByVendor,
  latestSeatByVendorOnOrBefore,
  type FixedCostSeatRow as ProrateSeatRow,
} from '../fixed-costs/fixed-cost-prorate';

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
  line_item?: string | null;
  cost_type?: string | null;
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
  if (unit > 0) {
    return unit;
  }
  const seats = n(snapshot.seats);
  const cost = n(snapshot.costUsd);
  if (seats > 0 && cost > 0) {
    return cost / seats;
  }
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

function toProrateRows(rows: FixedCostSeatRow[]): ProrateSeatRow[] {
  return rows.map((row) => ({
    period_month: String(row.period_month),
    vendor:
      String(row.vendor ?? '')
        .trim()
        .toLowerCase() || 'other',
    cost_usd: n(row.cost_usd),
    seats: n(row.seats),
    line_item: row.line_item,
    cost_type: row.cost_type,
  }));
}

/**
 * Per vendor: current carried-forward seats vs the previous calendar month.
 * Date range does not drop vendors whose last admin row is outside the filter.
 */
export function vendorSeatChanges(
  rows: FixedCostSeatRow[],
  _from: string,
  _to: string,
): { latestMonth: string | null; changes: Record<string, VendorSeatChange> } {
  const mapped = toProrateRows(rows);
  const currentByVendor = latestSeatByVendor(mapped);
  let latestMonth: string | null = null;
  const changes: Record<string, VendorSeatChange> = {};

  for (const [vendor, current] of currentByVendor) {
    if (!latestMonth || current.period_month > latestMonth) {
      latestMonth = current.period_month;
    }
    const priorMonth = previousCalendarMonth(current.period_month);
    const priorSnap = latestSeatByVendorOnOrBefore(mapped, priorMonth).get(vendor);
    const currentSeat: SeatSnapshot = {
      seats: current.seats,
      unitCostUsd: 0,
      costUsd: current.seat_usd,
    };
    if (!priorSnap || priorSnap.period_month === current.period_month) {
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
    const priorSeat: SeatSnapshot = {
      seats: priorSnap.seats,
      unitCostUsd: 0,
      costUsd: priorSnap.seat_usd,
    };
    const delta = seatPriceDelta(currentSeat, priorSeat);
    const seatsChanged = delta.seatDelta !== 0;
    changes[vendor] = {
      vendor,
      seats: current.seats,
      prior_seats: priorSeat.seats,
      usd_from_seats: seatsChanged ? delta.usdFromSeats : 0,
      usd_from_rate: seatsChanged ? 0 : delta.usdFromRate,
      prior_period_month: priorSnap.period_month,
    };
  }

  return { latestMonth, changes };
}
