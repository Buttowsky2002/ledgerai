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

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/** Per-seat unit: stored unit_cost_usd, else cost / seats (enterprise contracts). */
export function resolveUnitCost(snapshot: SeatSnapshot): number {
  const unit = n(snapshot.unitCostUsd);
  if (unit > 0) return unit;
  const seats = n(snapshot.seats);
  const cost = n(snapshot.costUsd);
  if (seats > 0 && cost > 0) return cost / seats;
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

export function formatSignedUsd(amount: number): string {
  const formatted = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (amount > 0) return `+$${formatted}`;
  if (amount < 0) return `-$${formatted}`;
  return `$${formatted}`;
}

/** Compact line for save confirmation, e.g. "+2 seats · +$80.00/mo". */
export function formatSeatDeltaSummary(delta: SeatPriceDelta): string {
  const parts: string[] = [];
  if (delta.seatDelta !== 0) {
    const sign = delta.seatDelta > 0 ? '+' : '';
    const nSeats = Math.abs(delta.seatDelta);
    parts.push(`${sign}${delta.seatDelta} seat${nSeats === 1 ? '' : 's'}`);
  }
  const usdPart = delta.usdFromSeats !== 0 ? delta.usdFromSeats : delta.usdDelta;
  if (usdPart !== 0 || parts.length === 0) {
    parts.push(`${formatSignedUsd(usdPart)}/mo`);
  }
  return parts.join(' · ');
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

export function monthLabel(periodMonth: string): string {
  const d = new Date(`${monthStart(periodMonth)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return periodMonth.slice(0, 7);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
