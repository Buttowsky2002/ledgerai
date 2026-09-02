import {
  currentMonthlySeatRunRate,
  daysInBillingMonth,
  forecastFixedSeatCost,
  overlapDaysInBillingMonth,
  periodSeatTotalForRange,
  prorateMonthlyCost,
  seatLookupToDate,
  sumMonthlySeatCosts,
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

  it('sums full monthly seat costs without day proration', () => {
    expect(sumMonthlySeatCosts([{ cost_usd: 1380 }, { cost_usd: 1350 }])).toBe(2730);
  });

  it('uses latest admin seat config per vendor for monthly run-rate', () => {
    const rows = [
      { period_month: '2026-08-01', vendor: 'anthropic', cost_usd: 1380, seats: 46 },
      { period_month: '2026-09-01', vendor: 'openai', cost_usd: 1350, seats: 45 },
      { period_month: '2026-09-01', vendor: 'github', cost_usd: 214.72, seats: 11 },
    ];
    expect(currentMonthlySeatRunRate(rows)).toBe(2944.72);
    expect(periodSeatTotalForRange(rows, '2026-08-01', '2026-08-31')).toBe(2944.72);
    expect(forecastFixedSeatCost(2944.72, 365)).toBeCloseTo(35313.03, 0);
  });

  it('combines Anthropic plan lines instead of replacing the vendor with the newest month', () => {
    const rows = [
      {
        period_month: '2026-07-01',
        vendor: 'anthropic',
        line_item: 'Claude Team',
        cost_usd: 1380,
        seats: 46,
      },
      {
        period_month: '2026-09-01',
        vendor: 'anthropic',
        line_item: 'Claude Max',
        cost_usd: 400,
        seats: 4,
      },
    ];
    expect(currentMonthlySeatRunRate(rows)).toBe(1780);
    expect(periodSeatTotalForRange(rows, '2026-08-01', '2026-08-31')).toBe(1780);
  });

  it('seatLookupToDate extends past range ends through today', () => {
    expect(seatLookupToDate('2026-08-31', new Date('2026-09-02T12:00:00Z'))).toBe('2026-09-02');
    expect(seatLookupToDate('2026-09-15', new Date('2026-09-02T12:00:00Z'))).toBe('2026-09-15');
  });
});
