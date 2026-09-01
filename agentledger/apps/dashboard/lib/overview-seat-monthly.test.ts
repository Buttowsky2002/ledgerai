import assert from 'node:assert/strict';
import test from 'node:test';
import {
  billingMonthsInRange,
  currentMonthlySeatRunRate,
  latestBillingMonthInRange,
  latestMonthlyTotalsByVendor,
  latestSeatByVendor,
  monthlySeatByVendorForMonth,
  monthlySeatTotalForMonth,
  periodSeatTotal,
  periodSeatTotalForRange,
  priorSeatEntryForVendor,
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

test('priorSeatEntryForVendor returns latest row before billing month', () => {
  const rows = [
    { vendor: 'anthropic', period_month: '2026-07-01', line_item: 'Claude Team', cost_type: 'seat_license', seats: 62, unit_cost_usd: 20, cost_usd: 1240 },
    { vendor: 'anthropic', period_month: '2026-09-01', line_item: 'Claude Team', cost_type: 'seat_license', seats: 4, unit_cost_usd: 100, cost_usd: 400 },
  ];
  assert.deepEqual(
    priorSeatEntryForVendor(rows, 'anthropic', {
      beforeMonth: '2026-09',
      lineItem: 'Claude Team',
      costType: 'seat_license',
    }),
    { period_month: '2026-07-01', seats: 62, unit_cost_usd: 20, cost_usd: 1240 },
  );
});

test('latestMonthlyTotalsByVendor uses newest billing month only', () => {
  const rows = [
    { vendor: 'anthropic', period_month: '2026-07-01', cost_usd: 1240, seats: 62 },
    { vendor: 'openai', period_month: '2026-07-01', cost_usd: 1375, seats: 55 },
    { vendor: 'anthropic', period_month: '2026-09-01', cost_usd: 400, seats: 4 },
  ];
  assert.deepEqual(latestMonthlyTotalsByVendor(rows), [
    { vendor: 'openai', total: 1375 },
    { vendor: 'anthropic', total: 400 },
  ]);
});
