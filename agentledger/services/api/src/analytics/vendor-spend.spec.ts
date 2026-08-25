import {
  buildOrgVendorBilling,
  buildUserVendorSpend,
  platformToVendor,
  sumUserVendorSpend,
} from './vendor-spend';

describe('platformToVendor', () => {
  it('maps copilot platforms to github', () => {
    expect(platformToVendor('github_copilot')).toBe('github');
    expect(platformToVendor('GitHub Copilot')).toBe('github');
  });

  it('passes through known vendors', () => {
    expect(platformToVendor('anthropic')).toBe('anthropic');
    expect(platformToVendor('lovable')).toBe('lovable');
  });
});

describe('buildUserVendorSpend', () => {
  it('splits cursor seat and overage', () => {
    const spend = buildUserVendorSpend({
      model_breakdown: [],
      cursor_on_demand_usd: 50,
      cursor_seat_usd: 40,
    });
    expect(spend.cursor).toEqual({ seat_usd: 40, overage_usd: 50, total_usd: 90 });
  });

  it('maps metered anthropic to overage only', () => {
    const spend = buildUserVendorSpend({
      model_breakdown: [
        { model: 'claude-3', platform: 'anthropic', spend_usd: 12.5, calls: 3 },
      ],
      cursor_on_demand_usd: 0,
      cursor_seat_usd: 0,
    });
    expect(spend.anthropic).toEqual({ seat_usd: 0, overage_usd: 12.5, total_usd: 12.5 });
  });

  it('uses copilot seat and overage without double-counting breakdown', () => {
    const spend = buildUserVendorSpend({
      model_breakdown: [
        { model: 'Copilot', platform: 'github_copilot', spend_usd: 25, calls: 10 },
      ],
      cursor_on_demand_usd: 0,
      cursor_seat_usd: 0,
      copilot: { seat_usd: 19, overage_usd: 6 },
    });
    expect(spend.github).toEqual({ seat_usd: 19, overage_usd: 6, total_usd: 25 });
  });
});

describe('sumUserVendorSpend', () => {
  it('sums vendor totals', () => {
    expect(
      sumUserVendorSpend({
        cursor: { seat_usd: 40, overage_usd: 50, total_usd: 90 },
        anthropic: { seat_usd: 0, overage_usd: 10, total_usd: 10 },
      }),
    ).toBe(100);
  });
});

describe('buildOrgVendorBilling', () => {
  it('adds seat and overage', () => {
    const rows = buildOrgVendorBilling(
      { anthropic: 1375, openai: 1375 },
      { cursor: 1050.28, github: 459.22 },
    );
    expect(rows.find((r) => r.vendor === 'anthropic')).toMatchObject({
      seat_usd: 1375,
      budget_overage_usd: 0,
      total_usd: 1375,
    });
    expect(rows.find((r) => r.vendor === 'cursor')).toMatchObject({
      seat_usd: 0,
      budget_overage_usd: 1050.28,
      total_usd: 1050.28,
    });
  });
});
