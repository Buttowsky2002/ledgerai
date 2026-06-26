import { estimateCostFromTokens, enrichRecordCost } from './cost-estimator';

describe('cost-estimator', () => {
  it('estimates OpenAI gpt-4o-mini cost from tokens', () => {
    const cost = estimateCostFromTokens({
      provider: 'openai',
      model: 'gpt-4o-mini',
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    expect(cost).toBeCloseTo(0.15, 4);
  });

  it('enriches zero cost from tokens via price book', () => {
    const out = enrichRecordCost({
      provider: 'openai',
      model: 'gpt-4o-mini',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0,
    });
    expect(out.cost_usd).toBeGreaterThan(0);
    expect(out.cost_source).toBe('pricebook_estimate');
  });

  it('converts Anthropic cent amounts', () => {
    const out = enrichRecordCost({ amount: 250, cost_usd: 0, provider: 'anthropic' });
    expect(out.cost_usd).toBe(2.5);
    expect(out.cost_source).toBe('provider_cents');
  });

  it('preserves provider-reported cost', () => {
    const out = enrichRecordCost({ cost_usd: 1.25, input_tokens: 100 });
    expect(out.cost_usd).toBe(1.25);
    expect(out.cost_source).toBe('provider');
  });

  it('parses OpenAI-style amount objects', () => {
    const out = enrichRecordCost({
      cost_usd: 0,
      amount: { value: '0.42', currency: 'usd' },
    });
    expect(out.cost_usd).toBeCloseTo(0.42, 4);
    expect(out.cost_source).toBe('provider');
  });
});
