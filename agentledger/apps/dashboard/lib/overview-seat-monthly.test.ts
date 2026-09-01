import assert from 'node:assert/strict';
import test from 'node:test';
import {
  billingMonthsInRange,
  currentMonthlySeatRunRate,
  latestBillingMonthInRange,
  latestSeatByVendor,
  monthlySeatByVendorForMonth,
  monthlySeatTotalForMonth,
  periodSeatTotal,
  periodSeatTotalForRange,
} from './overview-seat-monthly';

test('billingMonthsInRange spans partial months inclusively', () => {
  assert.deepEqual(billingMonthsInRange('2026-08-15', '2026-08-31'), ['2026-08']);
  assert.deepEqual(billingMonthsInRange('2026-07-20', '2026-08-10'), ['2026-07', '2026-08']);
});

test('monthlySeatTotalForMonth sums one billing month only', () => {
  const rows = [
    { vendor: 'anthropic', period_month: '2026-08-01', cost_usd: 1380, seats: 46 },
    { vendor: 'openai', period_month: '2026-08-01', cost_usd: 1350, seats: 45 },
    { vendor: 'github', period_month: '2026-09-01', cost_usd: 214.72, seats: 11 },
  ];
  assert.equal(monthlySeatTotalForMonth(rows, '2026-08'), 2730);
  assert.equal(latestBillingMonthInRange('2026-08-01', '2026-08-31'), '2026-08');
  assert.equal(periodSeatTotal(rows, '2026-08-01', '2026-08-31'), 2730);
});

test('monthlySeatByVendorForMonth aggregates seats per vendor', () => {
  const map = monthlySeatByVendorForMonth(
    [{ vendor: 'anthropic', period_month: '2026-08-01', cost_usd: 1380, seats: 46 }],
    '2026-08',
  );
  assert.deepEqual(map.get('anthropic'), { seat_usd: 1380, seats: 46 });
});

test('currentMonthlySeatRunRate uses latest billing month per vendor', () => {
  const rows = [
    { vendor: 'anthropic', period_month: '2026-08-01', cost_usd: 1380, seats: 46 },
    { vendor: 'openai', period_month: '2026-09-01', cost_usd: 1350, seats: 45 },
    { vendor: 'github', period_month: '2026-09-01', cost_usd: 214.72, seats: 11 },
  ];
  assert.equal(currentMonthlySeatRunRate(rows), 2944.72);
  assert.equal(periodSeatTotalForRange(rows, '2026-08-01', '2026-08-31'), 2944.72);
  assert.equal(latestSeatByVendor(rows).get('openai')?.seat_usd, 1350);
});
