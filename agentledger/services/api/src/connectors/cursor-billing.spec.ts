import { classifyCursorBillingKind, enrichCursorBilling } from './cursor-billing';

describe('classifyCursorBillingKind', () => {
  it('maps On-Demand and Usage-based to on_demand', () => {
    expect(classifyCursorBillingKind('On-Demand')).toBe('on_demand');
    expect(classifyCursorBillingKind('Usage-based')).toBe('on_demand');
  });

  it('maps Included to included', () => {
    expect(classifyCursorBillingKind('Included')).toBe('included');
    expect(classifyCursorBillingKind('Included in Business')).toBe('included');
  });

  it('respects isChargeable when kind is empty', () => {
    expect(classifyCursorBillingKind('', true)).toBe('on_demand');
    expect(classifyCursorBillingKind('', false)).toBe('included');
  });
});

describe('enrichCursorBilling', () => {
  it('zeros billed cost for included usage while keeping usage value', () => {
    const out = enrichCursorBilling({
      provider: 'cursor',
      product: 'Included',
      cost_usd: 0.08,
      is_chargeable: false,
    });
    expect(out.usage_value_usd).toBe(0.08);
    expect(out.cost_usd).toBe(0);
    expect(out.billed_cost_usd).toBe(0);
    expect(out.operation_name).toBe('cursor:included');
    expect(out.cost_source).toBe('cursor_usage_value');
  });

  it('keeps full amount as billed for on-demand', () => {
    const out = enrichCursorBilling({
      provider: 'cursor',
      product: 'On-Demand',
      cost_usd: 8.75,
      is_chargeable: true,
    });
    expect(out.usage_value_usd).toBe(8.75);
    expect(out.cost_usd).toBe(8.75);
    expect(out.operation_name).toBe('cursor:on_demand');
    expect(out.cost_source).toBe('cursor_billed');
  });

  it('passes through non-cursor metrics', () => {
    const m = { provider: 'openai', cost_usd: 1 };
    expect(enrichCursorBilling(m)).toBe(m);
  });
});
