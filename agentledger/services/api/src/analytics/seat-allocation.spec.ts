import {
  allocateSeatPools,
  keywordSeatClass,
  mergeAllocatedWithConnectorFallback,
  presenceVendorsFromBreakdown,
  seatPoolsForRange,
  sumAllocatedSeats,
  vendorsWithFixedSeatPools,
  type SeatPool,
} from './seat-allocation';
import { buildUserVendorSpend, sumUserVendorSpend } from './vendor-spend';
import type { FixedCostSeatRow } from '../fixed-costs/fixed-cost-prorate';

describe('keywordSeatClass', () => {
  it('maps Team/Pro to basic and Max/Premium to premium', () => {
    expect(keywordSeatClass('Claude Team', 'seat_license')).toBe('basic');
    expect(keywordSeatClass('Claude Max', 'seat_license')).toBe('premium');
    expect(keywordSeatClass('ChatGPT Enterprise', 'subscription')).toBe('premium');
  });
});

describe('seatPoolsForRange', () => {
  const rows: FixedCostSeatRow[] = [
    {
      period_month: '2026-06-01',
      vendor: 'anthropic',
      cost_usd: 300,
      seats: 10,
      line_item: 'Claude Team',
      cost_type: 'seat_license',
    },
    {
      period_month: '2026-06-01',
      vendor: 'anthropic',
      cost_usd: 400,
      seats: 4,
      line_item: 'Claude Max',
      cost_type: 'seat_license',
    },
  ];

  it('splits basic and premium pools without double-counting', () => {
    const pools = seatPoolsForRange(rows, '2026-06-01', '2026-06-30');
    const basic = pools.find((p) => p.vendor === 'anthropic' && p.tier === 'basic');
    const premium = pools.find((p) => p.vendor === 'anthropic' && p.tier === 'premium');
    expect(basic?.seat_usd).toBe(300);
    expect(premium?.seat_usd).toBe(400);
    expect(basic!.seat_usd + premium!.seat_usd).toBe(700);
  });
});

describe('allocateSeatPools', () => {
  const pools: SeatPool[] = [
    { vendor: 'anthropic', tier: 'basic', seat_usd: 300, seats: 10 },
    { vendor: 'anthropic', tier: 'premium', seat_usd: 400, seats: 4 },
  ];

  it('assigns Fixed Overhead unit price to each eligible user (no seat-count drop)', () => {
    const presence = [
      { user_id: 'alice', vendors: ['anthropic'], activity_score: 10 },
      { user_id: 'bob', vendors: ['anthropic'], activity_score: 5 },
      { user_id: 'cara', vendors: ['anthropic'], activity_score: 1 },
    ];
    const basicOnly = allocateSeatPools({ pools, presence });
    // unit = 300/10 = 30
    expect(basicOnly.get('alice')!.anthropic).toBe(30);
    expect(basicOnly.get('bob')!.anthropic).toBe(30);
    expect(basicOnly.get('cara')!.anthropic).toBe(30);
    expect(sumAllocatedSeats(basicOnly)).toBe(90);

    const withPremium = allocateSeatPools({
      pools,
      presence,
      tiers: [{ user_id: 'alice', vendor: 'anthropic', tier: 'premium' }],
    });
    // Alice alone on premium: unit 400/4 = 100; bob+cara basic unit 30 each.
    expect(withPremium.get('alice')!.anthropic).toBe(100);
    expect(withPremium.get('bob')!.anthropic).toBe(30);
    expect(withPremium.get('cara')!.anthropic).toBe(30);
    expect(sumAllocatedSeats(withPremium)).toBe(160);
  });

  it('gives Anthropic-only user their FO unit seat with $0 overage', () => {
    const allocated = allocateSeatPools({
      pools: [{ vendor: 'anthropic', tier: 'basic', seat_usd: 30, seats: 1 }],
      presence: [{ user_id: 'dana', vendors: ['anthropic'] }],
    });
    const spend = buildUserVendorSpend({
      model_breakdown: [],
      cursor_on_demand_usd: 0,
      cursor_seat_usd: 0,
      allocated_seats: allocated.get('dana'),
    });
    expect(spend.anthropic).toEqual({ seat_usd: 30, overage_usd: 0, total_usd: 30 });
    expect(sumUserVendorSpend(spend)).toBe(30);
  });

  it('still assigns unit price when headcount exceeds purchased seats', () => {
    const presence = Array.from({ length: 12 }, (_, i) => ({
      user_id: `u${i}`,
      vendors: ['anthropic'],
      activity_score: 12 - i,
    }));
    const allocated = allocateSeatPools({
      pools: [{ vendor: 'anthropic', tier: 'basic', seat_usd: 300, seats: 10 }],
      presence,
    });
    expect(allocated.size).toBe(12);
    for (const row of allocated.values()) {
      expect(row.anthropic).toBe(30);
    }
    expect(sumAllocatedSeats(allocated)).toBe(360);
  });

  it('premium tag moves user to premium unit without inventing a new rate', () => {
    const presence = [
      { user_id: 'a', vendors: ['anthropic'] },
      { user_id: 'b', vendors: ['anthropic'] },
    ];
    const after = allocateSeatPools({
      pools,
      presence,
      tiers: [{ user_id: 'a', vendor: 'anthropic', tier: 'premium' }],
    });
    expect(after.get('a')!.anthropic).toBe(100); // 400/4
    expect(after.get('b')!.anthropic).toBe(30); // 300/10
  });

  it('equal-splits uncapped pools (seats = 0)', () => {
    const allocated = allocateSeatPools({
      pools: [{ vendor: 'openai', tier: 'basic', seat_usd: 90, seats: 0 }],
      presence: [
        { user_id: 'a', vendors: ['openai'] },
        { user_id: 'b', vendors: ['openai'] },
        { user_id: 'c', vendors: ['openai'] },
      ],
    });
    expect(allocated.get('a')!.openai).toBe(30);
    expect(allocated.get('b')!.openai).toBe(30);
    expect(allocated.get('c')!.openai).toBe(30);
    expect(sumAllocatedSeats(allocated)).toBe(90);
  });
});

describe('mergeAllocatedWithConnectorFallback', () => {
  it('keeps connector Cursor seats only when fixed_costs has no Cursor pool', () => {
    const allocated = new Map([['u1', { anthropic: 30 }]]);
    const connector = new Map([['u1', { cursor: 40, anthropic: 99 }]]);
    const fixed = vendorsWithFixedSeatPools([
      { vendor: 'anthropic', tier: 'basic', seat_usd: 30, seats: 1 },
    ]);
    const merged = mergeAllocatedWithConnectorFallback(allocated, connector, fixed);
    expect(merged.get('u1')).toEqual({ anthropic: 30, cursor: 40 });
  });
});

describe('presenceVendorsFromBreakdown', () => {
  it('maps platforms and extras', () => {
    expect(
      presenceVendorsFromBreakdown(
        [{ platform: 'github_copilot', spend_usd: 1 }],
        ['cursor'],
      ).sort(),
    ).toEqual(['cursor', 'github']);
  });
});
