import { mapFields, validateMetrics } from './field-mapper';

describe('field-mapper', () => {
  it('maps nested paths directly', () => {
    const { metrics } = mapFields(
      { usage: { input_tokens: 100, output_tokens: 50 }, model: { name: 'gpt-4o' } },
      [
        { type: 'direct', source: 'usage.input_tokens', target: 'input_tokens' },
        { type: 'direct', source: 'usage.output_tokens', target: 'output_tokens' },
        { type: 'direct', source: 'model.name', target: 'model' },
      ],
    );
    expect(metrics).toEqual({ input_tokens: 100, output_tokens: 50, model: 'gpt-4o' });
  });

  it('applies derived field mapping (sum)', () => {
    const { metrics } = mapFields(
      { cache_write_tokens_5m: 10, cache_write_tokens_1h: 5 },
      [{ type: 'derived', target: 'cache_write_tokens', expression: 'cache_write_tokens_5m + cache_write_tokens_1h' }],
    );
    expect(metrics.cache_write_tokens).toBe(15);
  });

  it('applies derived cents conversion', () => {
    const { metrics } = mapFields({ amount: 150 }, [{ type: 'derived', target: 'cost_usd', expression: 'amount / 100' }]);
    expect(metrics.cost_usd).toBe(1.5);
  });

  it('uses fallback fields', () => {
    const { metrics } = mapFields(
      { spend: 2.5 },
      [{ type: 'fallback', target: 'cost_usd', sources: ['cost_usd', 'spend', 'amount'] }],
    );
    expect(metrics.cost_usd).toBe(2.5);
  });

  it('reports missing required fields', () => {
    const metrics: Record<string, unknown> = {};
    const errors = validateMetrics(metrics, [{ field: 'model', required: true, type: 'string' }]);
    expect(errors).toContain('missing required field "model"');
  });

  it('rejects invalid numeric fields', () => {
    const metrics = { cost_usd: 'not-a-number' };
    const errors = validateMetrics(metrics, [{ field: 'cost_usd', type: 'number' }]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('parses currency objects', () => {
    const metrics = { cost_usd: { value: 150, currency: 'cents' } };
    validateMetrics(metrics, [{ field: 'cost_usd', type: 'currency' }]);
    expect(metrics.cost_usd).toBe(1.5);
  });
});
