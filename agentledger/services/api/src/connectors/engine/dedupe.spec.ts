import { computeDedupeHash } from './dedupe';

describe('dedupe', () => {
  it('uses provider record id strategy', () => {
    const h1 = computeDedupeHash({ strategy: 'provider_record_id' }, {}, 'rec-123');
    const h2 = computeDedupeHash({ strategy: 'provider_record_id' }, {}, 'rec-123');
    const h3 = computeDedupeHash({ strategy: 'provider_record_id' }, {}, 'rec-456');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('detects overlapping sync duplicates via period+model+cost', () => {
    const metrics = { period_start: '2026-01-01', model: 'gpt-4o', user_id: 'u1', product: 'api', cost_usd: 1.5 };
    const h1 = computeDedupeHash({ strategy: 'period_model_user_product_cost' }, metrics);
    const h2 = computeDedupeHash({ strategy: 'period_model_user_product_cost' }, { ...metrics });
    expect(h1).toBe(h2);
  });
});
