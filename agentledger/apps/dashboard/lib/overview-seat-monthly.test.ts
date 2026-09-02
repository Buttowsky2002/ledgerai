import assert from 'node:assert/strict';
import test from 'node:test';
import {
  billingMonthsInRange,
  currentMonthlySeatRunRate,
  keywordSeatClass,
  latestBillingMonthInRange,
  latestMonthlyTotalsByVendor,
  latestSeatByVendor,
  monthlySeatByVendorForMonth,
  monthlySeatTotalForMonth,
  periodSeatTotal,
  periodSeatTotalForRange,
  priorSeatEntryForVendor,
  seatLookupToDate,
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
    {
      vendor: 'anthropic',
      period_month: '2026-07-01',
      line_item: 'Claude Team',
      cost_type: 'seat_license',
      seats: 62,
      unit_cost_usd: 20,
      cost_usd: 1240,
    },
    {
      vendor: 'anthropic',
      period_month: '2026-09-01',
      line_item: 'Claude Team',
      cost_type: 'seat_license',
      seats: 4,
      unit_cost_usd: 100,
      cost_usd: 400,
    },
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

test('latestMonthlyTotalsByVendor carries forward older plan lines and sums by vendor', () => {
  const rows = [
    {
      vendor: 'anthropic',
      period_month: '2026-07-01',
      line_item: 'Claude Team',
      cost_usd: 1240,
      seats: 62,
    },
    {
      vendor: 'openai',
      period_month: '2026-07-01',
      line_item: 'ChatGPT Team',
      cost_usd: 1375,
      seats: 55,
    },
    {
      vendor: 'anthropic',
      period_month: '2026-09-01',
      line_item: 'Claude Max',
      cost_usd: 400,
      seats: 4,
    },
  ];
  assert.deepEqual(latestMonthlyTotalsByVendor(rows), [
    { vendor: 'anthropic', total: 1640 },
    { vendor: 'openai', total: 1375 },
  ]);
  const snap = latestSeatByVendor(rows).get('anthropic');
  assert.equal(snap?.seats, 66);
  assert.equal(snap?.seat_usd, 1640);
  assert.deepEqual(
    snap?.tiers.map((t) => ({ class: t.class, seats: t.seats, unit_usd: t.unit_usd })),
    [
      { class: 'basic', seats: 62, unit_usd: 20 },
      { class: 'premium', seats: 4, unit_usd: 100 },
    ],
  );
});

test('latestSeatByVendor replaces a plan when the same line item is updated', () => {
  const rows = [
    {
      vendor: 'anthropic',
      period_month: '2026-07-01',
      line_item: 'Claude Team',
      cost_usd: 1240,
      seats: 62,
    },
    {
      vendor: 'anthropic',
      period_month: '2026-09-01',
      line_item: 'Claude Team',
      cost_usd: 400,
      seats: 4,
    },
  ];
  const snap = latestSeatByVendor(rows).get('anthropic');
  assert.deepEqual(snap, { seat_usd: 400, seats: 4, period_month: '2026-09-01' });
});

test('current seats persist when the selected range ends before the latest billing month', () => {
  const rows = [
    {
      vendor: 'openai',
      period_month: '2026-06-01',
      line_item: 'ChatGPT Team',
      cost_usd: 1350,
      seats: 54,
    },
    {
      vendor: 'anthropic',
      period_month: '2026-07-01',
      line_item: 'Claude Team',
      cost_usd: 1380,
      seats: 46,
    },
    {
      vendor: 'anthropic',
      period_month: '2026-09-01',
      line_item: 'Claude Max',
      cost_usd: 400,
      seats: 4,
    },
  ];
  // 30-day / last-month filters still see the current combined vendor run-rate.
  assert.equal(currentMonthlySeatRunRate(rows), 3130);
  assert.equal(periodSeatTotalForRange(rows, '2026-08-01', '2026-08-31'), 3130);
});

test('keywordSeatClass maps plan names to basic vs premium', () => {
  assert.equal(keywordSeatClass('Claude Team', 'seat_license'), 'basic');
  assert.equal(keywordSeatClass('Claude Max', 'seat_license'), 'premium');
  assert.equal(keywordSeatClass('Claude Premium', 'seat_license'), 'premium');
  assert.equal(keywordSeatClass('ChatGPT Enterprise', 'subscription'), 'premium');
});

test('same-priced Team line in a later month replaces; Max stays a separate premium class', () => {
  const rows = [
    {
      vendor: 'anthropic',
      period_month: '2026-07-01',
      line_item: 'Claude Team',
      cost_usd: 1380,
      seats: 46,
      unit_cost_usd: 30,
    },
    {
      vendor: 'anthropic',
      period_month: '2026-09-01',
      line_item: 'Claude Premium',
      cost_usd: 400,
      seats: 4,
      unit_cost_usd: 100,
    },
  ];
  const snap = latestSeatByVendor(rows).get('anthropic');
  assert.equal(snap?.seats, 50);
  assert.equal(snap?.seat_usd, 1780);
  const basic = snap?.tiers.find((t) => t.class === 'basic');
  const premium = snap?.tiers.find((t) => t.class === 'premium');
  assert.equal(basic?.seats, 46);
  assert.equal(basic?.unit_usd, 30);
  assert.equal(premium?.seats, 4);
  assert.equal(premium?.unit_usd, 100);
});

test('seatLookupToDate keeps current seats visible on past ranges', () => {
  assert.equal(seatLookupToDate('2026-08-31', new Date('2026-09-02T12:00:00Z')), '2026-09-02');
});
