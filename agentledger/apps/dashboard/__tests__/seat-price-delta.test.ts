import {
  formatSeatDeltaSummary,
  formatSignedUsd,
  monthLabel,
  previousCalendarMonth,
  resolveUnitCost,
  seatPriceDelta,
} from '@/lib/seat-price-delta';

describe('resolveUnitCost', () => {
  it('prefers stored unit_cost_usd', () => {
    expect(resolveUnitCost({ seats: 10, unitCostUsd: 40, costUsd: 500 })).toBe(40);
  });

  it('falls back to cost / seats when unit is missing', () => {
    expect(resolveUnitCost({ seats: 10, unitCostUsd: 0, costUsd: 400 })).toBe(40);
  });

  it('returns 0 when there is nothing to divide', () => {
    expect(resolveUnitCost({ seats: 0, unitCostUsd: 0, costUsd: 400 })).toBe(0);
  });
});

describe('seatPriceDelta', () => {
  it('attributes a seat-only change to volume at the old unit', () => {
    const delta = seatPriceDelta(
      { seats: 12, unitCostUsd: 40, costUsd: 480 },
      { seats: 10, unitCostUsd: 40, costUsd: 400 },
    );
    expect(delta.seatDelta).toBe(2);
    expect(delta.usdFromSeats).toBe(80);
    expect(delta.usdFromRate).toBe(0);
    expect(delta.usdDelta).toBe(80);
  });

  it('attributes a unit-only change to rate', () => {
    const delta = seatPriceDelta(
      { seats: 10, unitCostUsd: 50, costUsd: 500 },
      { seats: 10, unitCostUsd: 40, costUsd: 400 },
    );
    expect(delta.seatDelta).toBe(0);
    expect(delta.usdFromSeats).toBe(0);
    expect(delta.usdFromRate).toBe(100);
    expect(delta.usdDelta).toBe(100);
  });

  it('splits a combined seat and unit change', () => {
    const delta = seatPriceDelta(
      { seats: 12, unitCostUsd: 50, costUsd: 600 },
      { seats: 10, unitCostUsd: 40, costUsd: 400 },
    );
    expect(delta.seatDelta).toBe(2);
    expect(delta.usdFromSeats).toBe(80);
    expect(delta.usdFromRate).toBe(120);
    expect(delta.usdDelta).toBe(200);
  });

  it('treats a new entry as fully from seats', () => {
    const delta = seatPriceDelta({ seats: 10, unitCostUsd: 40, costUsd: 400 }, null);
    expect(delta.seatDelta).toBe(10);
    expect(delta.usdFromSeats).toBe(400);
    expect(delta.usdFromRate).toBe(0);
    expect(delta.prior).toBeNull();
  });

  it('uses implied unit when stored unit is zero', () => {
    const delta = seatPriceDelta(
      { seats: 12, unitCostUsd: 0, costUsd: 600 },
      { seats: 10, unitCostUsd: 0, costUsd: 400 },
    );
    expect(delta.usdFromSeats).toBe(80);
  });

  it('records a seat reduction as a negative volume effect', () => {
    const delta = seatPriceDelta(
      { seats: 8, unitCostUsd: 40, costUsd: 320 },
      { seats: 10, unitCostUsd: 40, costUsd: 400 },
    );
    expect(delta.seatDelta).toBe(-2);
    expect(delta.usdFromSeats).toBe(-80);
  });
});

describe('formatSeatDeltaSummary', () => {
  it('joins seat count and dollar volume', () => {
    const delta = seatPriceDelta(
      { seats: 12, unitCostUsd: 40, costUsd: 480 },
      { seats: 10, unitCostUsd: 40, costUsd: 400 },
    );
    expect(formatSeatDeltaSummary(delta)).toBe('+2 seats · +$80.00/mo');
  });

  it('uses singular seat', () => {
    const delta = seatPriceDelta(
      { seats: 11, unitCostUsd: 40, costUsd: 440 },
      { seats: 10, unitCostUsd: 40, costUsd: 400 },
    );
    expect(formatSeatDeltaSummary(delta)).toBe('+1 seat · +$40.00/mo');
  });
});

describe('formatSignedUsd', () => {
  it('signs positive and negative amounts', () => {
    expect(formatSignedUsd(80)).toBe('+$80.00');
    expect(formatSignedUsd(-80)).toBe('-$80.00');
    expect(formatSignedUsd(0)).toBe('$0.00');
  });
});

describe('monthLabel', () => {
  it('formats a period_month as a short UTC month', () => {
    expect(monthLabel('2026-07-01')).toBe('Jul 2026');
  });
});

describe('previousCalendarMonth', () => {
  it('rolls back across year boundaries', () => {
    expect(previousCalendarMonth('2026-01-01')).toBe('2025-12-01');
  });
});
