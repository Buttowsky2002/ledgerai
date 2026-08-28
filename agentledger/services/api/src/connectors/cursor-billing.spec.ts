import {
  classifyCursorBillingKind,
  coerceIsChargeable,
  enrichCursorBilling,
} from './cursor-billing';

describe('classifyCursorBillingKind', () => {
  it('maps On-Demand and Usage-based to on_demand', () => {
    expect(classifyCursorBillingKind('On-Demand')).toBe('on_demand');
    expect(classifyCursorBillingKind('Usage-based')).toBe('on_demand');
    expect(classifyCursorBillingKind('on_demand')).toBe('on_demand');
    expect(classifyCursorBillingKind('usage_based')).toBe('on_demand');
  });

  it('maps Included to included', () => {
    expect(classifyCursorBillingKind('Included')).toBe('included');
    expect(classifyCursorBillingKind('Included in Business')).toBe('included');
  });

  it('respects isChargeable when kind is empty', () => {
    expect(classifyCursorBillingKind('', true)).toBe('on_demand');
    expect(classifyCursorBillingKind('', false)).toBe('included');
  });

  it('prefers isChargeable over unknown kind strings', () => {
    expect(classifyCursorBillingKind('SomethingElse', true)).toBe('on_demand');
    expect(classifyCursorBillingKind('SomethingElse', false)).toBe('included');
    expect(classifyCursorBillingKind('weird', 'true')).toBe('on_demand');
    expect(classifyCursorBillingKind('weird', 'false')).toBe('included');
  });

  it('prefers Usage-based kind over isChargeable false (true overage)', () => {
    expect(classifyCursorBillingKind('Usage-based', false)).toBe('on_demand');
    expect(classifyCursorBillingKind('USAGE_EVENT_KIND_USAGE_BASED', false)).toBe('on_demand');
  });

  it('prefers Included kind over isChargeable true (subscription pool)', () => {
    expect(classifyCursorBillingKind('Included in Business', true)).toBe('included');
    expect(classifyCursorBillingKind('USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS', true)).toBe(
      'included',
    );
  });

  it('maps errored kinds', () => {
    expect(classifyCursorBillingKind('Errored')).toBe('errored');
    expect(classifyCursorBillingKind('error', false)).toBe('errored');
  });
});

describe('coerceIsChargeable', () => {
  it('coerces string and number forms', () => {
    expect(coerceIsChargeable('true')).toBe(true);
    expect(coerceIsChargeable('false')).toBe(false);
    expect(coerceIsChargeable(1)).toBe(true);
    expect(coerceIsChargeable(0)).toBe(false);
    expect(coerceIsChargeable(undefined)).toBeUndefined();
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

  it('classifies Usage-based as on-demand even when isChargeable is false', () => {
    const out = enrichCursorBilling({
      provider: 'cursor',
      product: 'Usage-based',
      cost_usd: 37.33,
      is_chargeable: false,
    });
    expect(out.operation_name).toBe('cursor:on_demand');
    expect(out.cost_usd).toBe(37.33);
    expect(out.metered_cost_usd).toBeUndefined();
  });

  it('passes through non-cursor metrics', () => {
    const m = { provider: 'openai', cost_usd: 1 };
    expect(enrichCursorBilling(m)).toBe(m);
  });
});
