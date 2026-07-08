import { computeMeteredCostUsd, isNonMeteredCostSource } from './metered-cost';

describe('metered-cost', () => {
  it('excludes price-book estimates', () => {
    expect(
      computeMeteredCostUsd({
        provider: 'openai',
        model: 'gpt-4o',
        cost_usd: 1.25,
        cost_source: 'pricebook_estimate',
      }),
    ).toBe(0);
    expect(isNonMeteredCostSource('pricebook_estimate')).toBe(true);
  });

  it('includes provider-reported OpenAI/Anthropic costs', () => {
    expect(
      computeMeteredCostUsd({
        provider: 'openai',
        cost_usd: 12.5,
        cost_source: 'openai_cost_api',
      }),
    ).toBe(12.5);
    expect(
      computeMeteredCostUsd({
        provider: 'anthropic',
        cost_usd: 3.2,
        cost_source: 'anthropic_cost_report',
      }),
    ).toBe(3.2);
  });

  it('splits Cursor included vs on-demand', () => {
    expect(
      computeMeteredCostUsd({
        provider: 'cursor',
        cost_usd: 0,
        cost_source: 'cursor_usage_value',
        operation_name: 'cursor:included',
        usage_value_usd: 8,
      }),
    ).toBe(0);
    expect(
      computeMeteredCostUsd({
        provider: 'cursor',
        cost_usd: 20.18,
        cost_source: 'cursor_billed',
        operation_name: 'cursor:on_demand',
      }),
    ).toBe(20.18);
  });

  it('excludes GitHub Copilot from llm_calls metered totals', () => {
    expect(
      computeMeteredCostUsd({
        provider: 'github_copilot',
        cost_usd: 19,
        cost_source: 'estimate',
      }),
    ).toBe(0);
  });
});
