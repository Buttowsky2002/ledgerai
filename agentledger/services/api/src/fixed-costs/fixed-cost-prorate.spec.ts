import {
  daysInBillingMonth,
  overlapDaysInBillingMonth,
  prorateMonthlyCost,
  sumProratedMonthlyCosts,
} from './fixed-cost-prorate';

describe('fixed-cost-prorate', () => {
  it('counts overlap days within a billing month', () => {
    expect(overlapDaysInBillingMonth('2026-06-01', '2026-06-09', '2026-06-10')).toBe(2);
    expect(daysInBillingMonth('2026-06-01')).toBe(30);
  });

  it('prorates monthly seat cost by overlap days', () => {
    expect(prorateMonthlyCost(2730, '2026-06-01', '2026-06-09', '2026-06-10')).toBe(182);
    expect(prorateMonthlyCost(2730, '2026-06-01', '2026-06-01', '2026-06-30')).toBe(2730);
  });

  it('sums prorated rows across vendors', () => {
    const total = sumProratedMonthlyCosts(
      [
        { period_month: '2026-06-01', cost_usd: 1380 },
        { period_month: '2026-06-01', cost_usd: 1350 },
      ],
      '2026-06-09',
      '2026-06-10',
    );
    expect(total).toBe(182);
  });
});
