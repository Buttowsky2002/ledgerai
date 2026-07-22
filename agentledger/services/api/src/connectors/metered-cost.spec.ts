import {
  computeMeteredCostUsd,
  isNonMeteredCostSource,
  RECONCILED_MODEL_USAGE_SQL,
  RECONCILED_PROVIDER_SPEND_SQL,
  RECONCILED_TENANT_DAILY_SPEND_SQL,
  RECONCILED_USER_DAILY_SPEND_SQL,
} from './metered-cost';

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

  it('reconciled LARI SQL prefers portal_import over api per day', () => {
    for (const sql of [
      RECONCILED_USER_DAILY_SPEND_SQL,
      RECONCILED_TENANT_DAILY_SPEND_SQL,
      RECONCILED_PROVIDER_SPEND_SQL,
      RECONCILED_MODEL_USAGE_SQL,
    ]) {
      expect(sql).toContain("llm_calls.source = 'portal_import'");
      expect(sql).toContain("llm_calls.source = 'api'");
      expect(sql).toContain('CASE WHEN portal_usd > 0 THEN portal_usd ELSE api_usd END');
    }
    expect(RECONCILED_USER_DAILY_SPEND_SQL).toContain('AS calls');
    expect(RECONCILED_MODEL_USAGE_SQL).toContain('reconciled_input_tokens');
    expect(RECONCILED_TENANT_DAILY_SPEND_SQL).toContain('GROUP BY key, day');
  });

  it('reconciled SQL nests portal/api aggregates for Postgres (no same-SELECT aliases)', () => {
    // ClickHouse allows SELECT aliases in the same list; Postgres does not —
    // sumIf(... AS portal_usd) and CASE WHEN portal_usd must be separate SELECTs.
    for (const sql of [RECONCILED_PROVIDER_SPEND_SQL, RECONCILED_MODEL_USAGE_SQL]) {
      expect(sql).toContain(') AS aggregates');
      expect(sql).toContain('CASE WHEN portal_usd > 0 THEN portal_usd ELSE api_usd END');
    }
  });
});
