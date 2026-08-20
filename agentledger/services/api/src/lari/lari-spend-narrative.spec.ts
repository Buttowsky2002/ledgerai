import { buildBudgetSuggestions, buildSpendNarrative, spendDriverRecs } from './lari-spend-narrative';

describe('Spend narrative engine', () => {
  it('explains model concentration', () => {
    const result = buildSpendNarrative({
      product: 'openai',
      totalSpendUsd: 800,
      seatCostUsd: 0,
      meteredSpendUsd: 800,
      verdict: 'marginal',
      confidenceBasis: 'utilization',
      attributedValueUsd: 0,
      periodDays: 30,
      topDrivers: [],
      modelUsage: [{ provider: 'openai', model: 'gpt-4o', costUsd: 650 }],
      userUtilization: [],
    });
    expect(result.spendNarrative).toContain('81%');
    expect(result.spendNarrative).toContain('gpt-4o');
    expect(result.connectOutcomesPrompt).toBe(true);
  });

  it('detects period-over-period spend increase', () => {
    const result = buildSpendNarrative({
      product: 'anthropic',
      totalSpendUsd: 400,
      seatCostUsd: 0,
      meteredSpendUsd: 400,
      verdict: 'not_worth_it',
      confidenceBasis: 'none',
      attributedValueUsd: 0,
      periodDays: 30,
      topDrivers: [],
      modelUsage: [],
      userUtilization: [],
      priorTotalSpendUsd: 250,
    });
    expect(result.spendTrend).toBe('up');
    expect(result.periodChangePct).toBeGreaterThanOrEqual(25);
    expect(result.spendNarrative).toContain('prior period');
  });

  it('flags inactive seats in narrative', () => {
    const result = buildSpendNarrative({
      product: 'openai',
      totalSpendUsd: 600,
      seatCostUsd: 500,
      meteredSpendUsd: 100,
      verdict: 'not_worth_it',
      confidenceBasis: 'utilization',
      attributedValueUsd: 0,
      periodDays: 30,
      topDrivers: [],
      modelUsage: [],
      userUtilization: [
        {
          displayName: 'bob@test.com',
          providers: ['openai'],
          costUsd: 10,
          status: 'inactive',
          hasSeat: true,
          seatProvider: 'openai',
        },
      ],
    });
    expect(result.spendNarrative).toContain('inactive seat');
    expect(result.spendNarrative).toContain('Seat licenses');
  });
});

describe('Budget suggestions', () => {
  it('suggests tenant-level cap when products diverge', () => {
    const suggestions = buildBudgetSuggestions({
      periodDays: 30,
      products: [
        {
          product: 'openai',
          monthlyRunRateUsd: 1000,
          recommendedBudgetUsd: 700,
          verdict: 'not_worth_it',
          spendNarrative: 'Spend up 40% vs prior period.',
        },
        {
          product: 'anthropic',
          monthlyRunRateUsd: 500,
          recommendedBudgetUsd: 550,
          verdict: 'worth_it',
          spendNarrative: 'Strong ROI.',
        },
      ],
    });
    expect(suggestions.some((s) => s.scope === 'tenant')).toBe(true);
    expect(suggestions.some((s) => s.scope === 'product')).toBe(true);
  });

  it('suggests zero budget for retire agents', () => {
    const suggestions = buildBudgetSuggestions({
      periodDays: 30,
      products: [],
      agents: [
        {
          agentId: 'agent-x',
          costUsd: 300,
          valueUsd: 10,
          lari: -0.9,
          recommendation: 'retire',
        },
      ],
    });
    const agent = suggestions.find((s) => s.scopeId === 'agent-x');
    expect(agent?.recommendedBudgetUsd).toBe(0);
  });
});

describe('Spend driver recommendations', () => {
  it('flags spend spikes', () => {
    const recs = spendDriverRecs([
      {
        product: 'openai',
        totalSpendUsd: 500,
        spendNarrative: 'Spend up 50% vs prior period.',
        spendTrend: 'up',
        periodChangePct: 50,
        connectOutcomesPrompt: false,
      },
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.category).toBe('spend_driver');
    expect(recs[0]!.priority).toBe('high');
  });

  it('prompts outcome connection for import-only tenants', () => {
    const recs = spendDriverRecs([
      {
        product: 'anthropic',
        totalSpendUsd: 200,
        spendNarrative: 'Connect GitHub outcomes.',
        spendTrend: 'flat',
        periodChangePct: null,
        connectOutcomesPrompt: true,
      },
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.title).toContain('Missing outcome data');
  });
});
