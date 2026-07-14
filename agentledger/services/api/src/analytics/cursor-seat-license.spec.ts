import {
  computeCursorSeatLicenseFromFixedCosts,
  computeCursorSeatLicenseFromPlans,
  resolveCursorSeatUnitCost,
} from './cursor-seat-license';

describe('resolveCursorSeatUnitCost', () => {
  it('prefers unit_cost_usd when set', () => {
    expect(resolveCursorSeatUnitCost({ unit_cost_usd: 40, cost_usd: 600, seats: 15 })).toBe(40);
  });

  it('derives unit from cost and seats when unit_cost_usd is zero', () => {
    expect(resolveCursorSeatUnitCost({ unit_cost_usd: 0, cost_usd: 600, seats: 15 })).toBe(40);
  });
});

describe('computeCursorSeatLicenseFromFixedCosts', () => {
  it('prorates unit × active members for the overlapping billing month', () => {
    const result = computeCursorSeatLicenseFromFixedCosts(
      [{ period_month: '2026-07-01', cost_usd: 600, seats: 15, unit_cost_usd: 40 }],
      11,
      '2026-06-08',
      '2026-07-08',
    );
    // 11 × $40 = $440/mo; Jul 1–8 = 8/31 of month
    expect(result.seatUnitUsdPerMonth).toBe(40);
    expect(result.seatLicenseUsd).toBeCloseTo((440 * 8) / 31, 2);
  });

  it('prorates both months for June–July full range', () => {
    const result = computeCursorSeatLicenseFromFixedCosts(
      [
        { period_month: '2026-06-01', cost_usd: 600, seats: 15, unit_cost_usd: 40 },
        { period_month: '2026-07-01', cost_usd: 600, seats: 15, unit_cost_usd: 40 },
      ],
      11,
      '2026-06-01',
      '2026-07-31',
    );
    expect(result.seatCount).toBe(11);
    expect(result.seatUnitUsdPerMonth).toBe(40);
    expect(result.seatLicenseUsd).toBe(880); // 11 × $40 × 2 months
  });

  it('returns zero license when there are no active members', () => {
    expect(
      computeCursorSeatLicenseFromFixedCosts(
        [{ period_month: '2026-07-01', cost_usd: 600, seats: 15, unit_cost_usd: 40 }],
        0,
        '2026-06-08',
        '2026-07-08',
      ).seatLicenseUsd,
    ).toBe(0);
  });
});

describe('computeCursorSeatLicenseFromPlans', () => {
  it('uses active members × unit when members are known', () => {
    const result = computeCursorSeatLicenseFromPlans(
      [{ seats_purchased: 20, monthly_price_per_user: 40, contract_monthly_cost: 0 }],
      11,
      '2026-06-01',
      '2026-07-31',
    );
    expect(result.seatLicenseUsd).toBe(880);
    expect(result.seatCount).toBe(11);
  });
});
