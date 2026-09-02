import {
  previousCalendarMonth,
  resolveUnitCost,
  seatPriceDelta,
  vendorSeatChanges,
} from './seat-price-delta';

describe('previousCalendarMonth', () => {
  it('rolls back across year boundaries', () => {
    expect(previousCalendarMonth('2026-01-01')).toBe('2025-12-01');
    expect(previousCalendarMonth('2026-07-01')).toBe('2026-06-01');
  });
});

describe('resolveUnitCost', () => {
  it('prefers stored unit_cost_usd', () => {
    expect(resolveUnitCost({ seats: 10, unitCostUsd: 40, costUsd: 500 })).toBe(40);
  });

  it('falls back to cost / seats when unit is missing', () => {
    expect(resolveUnitCost({ seats: 10, unitCostUsd: 0, costUsd: 400 })).toBe(40);
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
  });

  it('attributes a unit-only change to rate', () => {
    const delta = seatPriceDelta(
      { seats: 10, unitCostUsd: 50, costUsd: 500 },
      { seats: 10, unitCostUsd: 40, costUsd: 400 },
    );
    expect(delta.seatDelta).toBe(0);
    expect(delta.usdFromSeats).toBe(0);
    expect(delta.usdFromRate).toBe(100);
  });

  it('splits a combined seat and unit change', () => {
    const delta = seatPriceDelta(
      { seats: 12, unitCostUsd: 50, costUsd: 600 },
      { seats: 10, unitCostUsd: 40, costUsd: 400 },
    );
    expect(delta.usdFromSeats).toBe(80);
    expect(delta.usdFromRate).toBe(120);
  });

  it('treats a new entry as fully from seats', () => {
    const delta = seatPriceDelta({ seats: 10, unitCostUsd: 40, costUsd: 400 }, null);
    expect(delta.usdFromSeats).toBe(400);
    expect(delta.usdFromRate).toBe(0);
  });
});

describe('vendorSeatChanges', () => {
  const rows = [
    { period_month: '2026-06-01', vendor: 'cursor', seats: 10, unit_cost_usd: 40, cost_usd: 400 },
    { period_month: '2026-07-01', vendor: 'cursor', seats: 12, unit_cost_usd: 40, cost_usd: 480 },
    { period_month: '2026-07-01', vendor: 'openai', seats: 5, unit_cost_usd: 30, cost_usd: 150 },
  ];

  it('compares each vendor to its previous calendar month', () => {
    const { latestMonth, changes } = vendorSeatChanges(rows, '2026-07-01', '2026-07-31');
    expect(latestMonth).toBe('2026-07-01');
    expect(changes.cursor).toMatchObject({
      seats: 12,
      prior_seats: 10,
      usd_from_seats: 80,
      usd_from_rate: 0,
      prior_period_month: '2026-06-01',
    });
    // First-time vendor (no prior month) is not a seat *change*.
    expect(changes.openai).toMatchObject({
      seats: 5,
      prior_seats: null,
      usd_from_seats: 0,
      prior_period_month: null,
    });
  });

  it('reports zero seat-change dollars when only unit price moved', () => {
    const rateOnly = [
      { period_month: '2026-06-01', vendor: 'cursor', seats: 10, unit_cost_usd: 40, cost_usd: 400 },
      { period_month: '2026-07-01', vendor: 'cursor', seats: 10, unit_cost_usd: 50, cost_usd: 500 },
    ];
    const { changes } = vendorSeatChanges(rateOnly, '2026-07-01', '2026-07-31');
    expect(changes.cursor.usd_from_seats).toBe(0);
    expect(changes.cursor.prior_seats).toBe(10);
    expect(changes.cursor.seats).toBe(10);
  });

  it('uses the latest month overlapping a multi-month range', () => {
    const { latestMonth, changes } = vendorSeatChanges(rows, '2026-06-01', '2026-07-31');
    expect(latestMonth).toBe('2026-07-01');
    expect(changes.cursor.prior_seats).toBe(10);
  });

  it('sums multiple line items for the same vendor-month', () => {
    const mixed = [
      { period_month: '2026-06-01', vendor: 'openai', seats: 10, unit_cost_usd: 30, cost_usd: 300 },
      { period_month: '2026-07-01', vendor: 'openai', seats: 4, unit_cost_usd: 30, cost_usd: 120 },
      { period_month: '2026-07-01', vendor: 'openai', seats: 8, unit_cost_usd: 30, cost_usd: 240 },
    ];
    const { changes } = vendorSeatChanges(mixed, '2026-07-01', '2026-07-31');
    expect(changes.openai.seats).toBe(12);
    expect(changes.openai.prior_seats).toBe(10);
    expect(changes.openai.usd_from_seats).toBe(60);
  });

  it('persists current OpenAI seats when the selected range has no OpenAI row', () => {
    const { changes } = vendorSeatChanges(rows, '2026-08-01', '2026-08-31');
    expect(changes.openai.seats).toBe(5);
  });

  it('combines Anthropic plan lines across months into one vendor total', () => {
    const mixed = [
      {
        period_month: '2026-07-01',
        vendor: 'anthropic',
        line_item: 'Claude Team',
        seats: 62,
        unit_cost_usd: 20,
        cost_usd: 1240,
      },
      {
        period_month: '2026-09-01',
        vendor: 'anthropic',
        line_item: 'Claude Max',
        seats: 4,
        unit_cost_usd: 100,
        cost_usd: 400,
      },
    ];
    const { changes } = vendorSeatChanges(mixed, '2026-08-01', '2026-08-31');
    expect(changes.anthropic.seats).toBe(66);
    expect(changes.anthropic.prior_seats).toBe(62);
  });
});
