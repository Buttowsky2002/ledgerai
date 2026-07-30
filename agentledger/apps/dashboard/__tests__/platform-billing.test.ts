import {
  fixedCostVendorForPlatform,
  isSeatAllocatedPlatform,
  platformBillingSplit,
  seatUsdByVendor,
} from '@/lib/platform-billing';

describe('fixedCostVendorForPlatform', () => {
  it('maps platform slugs onto fixed_costs vendor ids', () => {
    expect(fixedCostVendorForPlatform('anthropic')).toBe('anthropic');
    expect(fixedCostVendorForPlatform('cursor')).toBe('cursor');
    expect(fixedCostVendorForPlatform('github_copilot')).toBe('github');
    expect(fixedCostVendorForPlatform('GitHub Copilot')).toBe('github');
    expect(fixedCostVendorForPlatform('azure_openai')).toBe('azure');
    expect(fixedCostVendorForPlatform('bedrock')).toBe('aws');
  });
});

describe('isSeatAllocatedPlatform', () => {
  it('treats every Copilot spelling as seat-allocated', () => {
    expect(isSeatAllocatedPlatform('github_copilot')).toBe(true);
    expect(isSeatAllocatedPlatform('github_copilot_business')).toBe(true);
    expect(isSeatAllocatedPlatform('GitHub Copilot')).toBe(true);
  });

  it('does not claim usage-billed platforms are seat-allocated', () => {
    expect(isSeatAllocatedPlatform('anthropic')).toBe(false);
    expect(isSeatAllocatedPlatform('cursor')).toBe(false);
    expect(isSeatAllocatedPlatform('openai')).toBe(false);
  });
});

describe('seatUsdByVendor', () => {
  it('sums fixed-cost rows per vendor and tolerates string amounts', () => {
    expect(
      seatUsdByVendor([
        { vendor: 'anthropic', cost_usd: 1375 },
        { vendor: 'anthropic', cost_usd: '125.5' },
        { vendor: 'cursor', cost_usd: 800 },
      ]),
    ).toEqual({ anthropic: 1500.5, cursor: 800 });
  });

  it('skips zero and unparseable amounts, and buckets a missing vendor as other', () => {
    expect(
      seatUsdByVendor([
        { vendor: 'openai', cost_usd: 0 },
        { vendor: 'openai', cost_usd: 'not-a-number' },
        { vendor: null, cost_usd: 42 },
      ]),
    ).toEqual({ other: 42 });
  });
});

describe('platformBillingSplit', () => {
  it('reports a usage-billed platform with no seat licence as metered only', () => {
    expect(platformBillingSplit('anthropic', 714.88)).toEqual({
      meteredUsd: 714.88,
      seatUsd: 0,
      cursorIncludedUsd: 0,
    });
  });

  it('reports metered plus seat when the vendor also has a fixed cost', () => {
    // The pilot case: Anthropic has a Claude Team seat licence *and* metered
    // spend, which the old hardcoded badge rendered as plain "Metered".
    expect(platformBillingSplit('anthropic', 714.88, { anthropic: 1375 })).toEqual({
      meteredUsd: 714.88,
      seatUsd: 1375,
      cursorIncludedUsd: 0,
    });
  });

  it('counts Copilot platform spend as seat allocation, never metered', () => {
    expect(platformBillingSplit('github_copilot', 950, { github: 400 })).toEqual({
      meteredUsd: 0,
      seatUsd: 1350,
      cursorIncludedUsd: 0,
    });
  });

  it('keeps Cursor subscription-included value out of both metered and seat', () => {
    expect(platformBillingSplit('cursor', 2264.1, { cursor: 1600 }, 5200)).toEqual({
      meteredUsd: 2264.1,
      seatUsd: 1600,
      cursorIncludedUsd: 5200,
    });
  });

  it('defaults missing or non-finite inputs to zero rather than NaN', () => {
    expect(platformBillingSplit('openai', Number.NaN)).toEqual({
      meteredUsd: 0,
      seatUsd: 0,
      cursorIncludedUsd: 0,
    });
    expect(platformBillingSplit('openai', 10, {}, -5).cursorIncludedUsd).toBe(0);
  });
});
