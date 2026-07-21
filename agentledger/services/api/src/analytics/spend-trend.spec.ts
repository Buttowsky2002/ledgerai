import { computeSpendTrend } from './spend-trend';

describe('computeSpendTrend', () => {
  it('returns insufficient with fewer than two daily points', () => {
    expect(computeSpendTrend([])).toEqual({ direction: 'insufficient' });
    expect(computeSpendTrend([{ day: '2026-06-01', cost_usd: 10 }])).toEqual({ direction: 'insufficient' });
  });

  it('detects uptrend when latter-half avg daily spend rises', () => {
    const daily = [
      { day: '2026-06-01', cost_usd: 10 },
      { day: '2026-06-02', cost_usd: 10 },
      { day: '2026-06-03', cost_usd: 20 },
      { day: '2026-06-04', cost_usd: 20 },
    ];
    expect(computeSpendTrend(daily)).toEqual({ direction: 'up', change_pct: 100, change_usd: 10 });
  });

  it('detects downtrend when latter-half avg daily spend falls', () => {
    const daily = [
      { day: '2026-06-01', cost_usd: 20 },
      { day: '2026-06-02', cost_usd: 20 },
      { day: '2026-06-03', cost_usd: 10 },
      { day: '2026-06-04', cost_usd: 10 },
    ];
    expect(computeSpendTrend(daily)).toEqual({ direction: 'down', change_pct: -50, change_usd: -10 });
  });

  it('returns flat when change is within threshold', () => {
    const daily = [
      { day: '2026-06-01', cost_usd: 100 },
      { day: '2026-06-02', cost_usd: 102 },
    ];
    expect(computeSpendTrend(daily)).toEqual({ direction: 'flat', change_pct: 2, change_usd: 2 });
  });
});
