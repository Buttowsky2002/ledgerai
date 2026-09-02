import { keywordSeatClass, latestSeatByVendor } from '../lib/overview-seat-monthly';

describe('keywordSeatClass', () => {
  it('maps Team/Pro to basic and Max/Premium/Enterprise to premium', () => {
    expect(keywordSeatClass('Claude Team', 'seat_license')).toBe('basic');
    expect(keywordSeatClass('Claude Max', 'seat_license')).toBe('premium');
    expect(keywordSeatClass('Claude Premium', 'seat_license')).toBe('premium');
    expect(keywordSeatClass('ChatGPT Enterprise', 'subscription')).toBe('premium');
  });
});

describe('latestSeatByVendor tiers', () => {
  it('keeps Anthropic basic and premium seats separate with their own prices', () => {
    const snap = latestSeatByVendor([
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
    ]).get('anthropic');

    expect(snap?.seats).toBe(50);
    expect(snap?.seat_usd).toBe(1780);
    expect(snap?.tiers).toEqual([
      { class: 'basic', seats: 46, seat_usd: 1380, unit_usd: 30 },
      { class: 'premium', seats: 4, seat_usd: 400, unit_usd: 100 },
    ]);
  });

  it('splits same-vendor lines by unit price when names are both Team-like', () => {
    const snap = latestSeatByVendor([
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
        line_item: 'Claude Team Max',
        cost_usd: 400,
        seats: 4,
        unit_cost_usd: 100,
      },
    ]).get('anthropic');

    const basic = snap?.tiers.find((t) => t.class === 'basic');
    const premium = snap?.tiers.find((t) => t.class === 'premium');
    expect(basic?.seats).toBe(46);
    expect(premium?.seats).toBe(4);
    expect(premium?.unit_usd).toBe(100);
  });
});
