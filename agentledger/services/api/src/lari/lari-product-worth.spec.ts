import {
  buildProductWorthScorecard,
  budgetSuggestionRecs,
  productWorthRecs,
} from './lari-product-worth';
import type { ProductWorthInput } from './lari-product-worth.types';

const baseInput = (): ProductWorthInput => ({
  periodDays: 30,
  providerSpend: [
    { provider: 'openai', costUsd: 800, calls: 4000 },
    { provider: 'anthropic', costUsd: 200, calls: 500 },
  ],
  subscriptionPlans: [
    {
      provider: 'openai',
      seatsPurchased: 10,
      contractMonthlyCost: 500,
      activeSeats: 6,
    },
  ],
  providerRankings: [
    {
      provider: 'openai',
      costUsd: 800,
      calls: 4000,
      attributedValueUsd: 400,
      valuePerDollar: 0.5,
      efficiencyScore: 30,
      rank: 2,
    },
    {
      provider: 'anthropic',
      costUsd: 200,
      calls: 500,
      attributedValueUsd: 600,
      valuePerDollar: 3,
      efficiencyScore: 90,
      rank: 1,
    },
  ],
  modelUsage: [
    { provider: 'openai', model: 'gpt-4o', costUsd: 600 },
    { provider: 'anthropic', model: 'claude-sonnet', costUsd: 180 },
  ],
  userUtilization: [
    {
      displayName: 'alice@co.test',
      providers: ['openai'],
      costUsd: 500,
      status: 'active',
      hasSeat: true,
      seatProvider: 'openai',
      seatMonthlyCostUsd: 50,
    },
    {
      displayName: 'bob@co.test',
      providers: ['openai'],
      costUsd: 50,
      status: 'inactive',
      hasSeat: true,
      seatProvider: 'openai',
      seatMonthlyCostUsd: 50,
    },
  ],
});

describe('Product Worth Scorecard', () => {
  it('marks high value/$ products as worth_it', () => {
    const scorecard = buildProductWorthScorecard('2026-01-01', '2026-01-31', baseInput());
    const anthropic = scorecard.products.find((p) => p.product === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic!.verdict).toBe('worth_it');
    expect(anthropic!.worthRatio).toBeGreaterThanOrEqual(1);
  });

  it('marks low value/$ products as marginal or not_worth_it', () => {
    const scorecard = buildProductWorthScorecard('2026-01-01', '2026-01-31', baseInput());
    const openai = scorecard.products.find((p) => p.product === 'openai');
    expect(openai).toBeDefined();
    expect(['marginal', 'not_worth_it']).toContain(openai!.verdict);
  });

  it('includes top spend drivers', () => {
    const scorecard = buildProductWorthScorecard('2026-01-01', '2026-01-31', baseInput());
    const openai = scorecard.products.find((p) => p.product === 'openai');
    expect(openai!.topDrivers.length).toBeGreaterThan(0);
    expect(openai!.topDrivers.some((d) => d.type === 'model')).toBe(true);
  });

  it('suggests budget caps for underperforming products', () => {
    const scorecard = buildProductWorthScorecard('2026-01-01', '2026-01-31', baseInput());
    const budgetRecs = budgetSuggestionRecs(scorecard);
    expect(budgetRecs.length).toBeGreaterThan(0);
    expect(budgetRecs.every((r) => r.category === 'budget_suggestion')).toBe(true);
  });

  it('emits product_worth recommendations for marginal/not_worth products', () => {
    const scorecard = buildProductWorthScorecard('2026-01-01', '2026-01-31', baseInput());
    const recs = productWorthRecs(scorecard);
    expect(recs.some((r) => r.category === 'product_worth')).toBe(true);
    expect(recs.some((r) => r.relatedEntity?.id === 'openai')).toBe(true);
  });

  it('uses utilization-only verdict when no outcomes exist', () => {
    const input = baseInput();
    input.providerRankings = input.providerRankings.map((r) => ({
      ...r,
      attributedValueUsd: 0,
      valuePerDollar: 0,
    }));
    const scorecard = buildProductWorthScorecard('2026-01-01', '2026-01-31', input);
    const anthropic = scorecard.products.find((p) => p.product === 'anthropic');
    expect(anthropic!.confidenceBasis).toBe('utilization');
    expect(['marginal', 'insufficient_data', 'not_worth_it']).toContain(anthropic!.verdict);
  });

  it('computes portfolio summary', () => {
    const scorecard = buildProductWorthScorecard('2026-01-01', '2026-01-31', baseInput());
    expect(scorecard.summary.productCount).toBe(2);
    expect(scorecard.summary.totalSpendUsd).toBeGreaterThan(0);
    expect(scorecard.budgetSuggestions).toBeDefined();
    expect(scorecard.dataCoverage).toBeDefined();
    expect(scorecard.products[0]!.spendNarrative).toBeTruthy();
  });
});
