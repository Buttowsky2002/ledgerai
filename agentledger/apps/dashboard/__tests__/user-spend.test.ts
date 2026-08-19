import { userBillableSpendUsd, userTotalSpendUsd } from '../lib/user-spend';

describe('userBillableSpendUsd', () => {
  it('uses cost_usd when it already includes cursor on-demand', () => {
    expect(
      userBillableSpendUsd({
        cost_usd: 985.69,
        metered_usd: 985.69,
        cursor_on_demand_usd: 985.69,
      }),
    ).toBe(985.69);
  });

  it('adds copilot seat when metered is zero', () => {
    expect(
      userBillableSpendUsd({
        cost_usd: 16.57,
        metered_usd: 0,
        seat_usd: 16.57,
      }),
    ).toBe(16.57);
  });

  it('combines openai metered with cursor on-demand without double-counting', () => {
    expect(
      userBillableSpendUsd({
        cost_usd: 110.5,
        metered_usd: 110.5,
        cursor_on_demand_usd: 95.5,
        seat_usd: 0,
      }),
    ).toBe(110.5);
  });
});

describe('userTotalSpendUsd', () => {
  it('adds cursor included usage value to billable (Brandon-style)', () => {
    expect(
      userTotalSpendUsd({
        cost_usd: 985.69,
        metered_usd: 985.69,
        cursor_on_demand_usd: 985.69,
        cursor_included_usd: 365.95,
      }),
    ).toBeCloseTo(1351.64, 2);
  });

  it('uses total_spend_usd + included for user directory rows', () => {
    expect(
      userTotalSpendUsd({
        total_spend_usd: 985.69,
        cursor_included_usd: 365.95,
      }),
    ).toBeCloseTo(1351.64, 2);
  });

  it('returns included-only spend when billable is zero', () => {
    expect(
      userTotalSpendUsd({
        total_spend_usd: 0,
        cursor_included_usd: 42.1,
      }),
    ).toBe(42.1);
  });

  it('does not double-count cursor on-demand in total', () => {
    const total = userTotalSpendUsd({
      cost_usd: 200,
      metered_usd: 200,
      cursor_on_demand_usd: 150,
      cursor_included_usd: 50,
    });
    expect(total).toBe(250);
  });
});
