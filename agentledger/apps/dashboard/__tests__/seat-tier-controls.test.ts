import {
  AI_VENDORS,
  defaultUnitUsd,
  PLAN_TIER_BUTTON_LABELS,
  vendorLabel,
} from '../lib/fixed-cost-catalog';

/** Mirrors SeatTierControls license label + always-on ChatGPT/Anthropic vendors. */
function licenseLabel(vendor: string): string {
  const entry = AI_VENDORS.find((v) => v.id === vendor);
  if (vendor === 'openai') {
    return 'ChatGPT';
  }
  if (entry?.product) {
    return entry.product;
  }
  return vendorLabel(vendor);
}

function tierVendorsForUser(userVendors: string[], orgVendors: string[]): string[] {
  return [...new Set(['openai', 'anthropic', ...userVendors, ...orgVendors])];
}

describe('SeatTierControls license helpers', () => {
  it('always includes ChatGPT (openai) and Claude (anthropic)', () => {
    expect(tierVendorsForUser([], [])).toEqual(['openai', 'anthropic']);
    expect(tierVendorsForUser(['cursor'], ['github'])).toEqual([
      'openai',
      'anthropic',
      'cursor',
      'github',
    ]);
  });

  it('labels openai as ChatGPT and shows FO unit price hints', () => {
    expect(licenseLabel('openai')).toBe('ChatGPT');
    expect(licenseLabel('anthropic')).toBe('Claude');
    expect(PLAN_TIER_BUTTON_LABELS.team).toBe('Basic');
    expect(PLAN_TIER_BUTTON_LABELS.premium).toBe('Premium');
    expect(defaultUnitUsd('openai', 'team')).toBe(30);
    expect(defaultUnitUsd('anthropic', 'team')).toBe(30);
    expect(defaultUnitUsd('anthropic', 'premium')).toBe(100);
  });
});
