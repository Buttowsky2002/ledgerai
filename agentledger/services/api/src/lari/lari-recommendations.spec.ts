import {
  generateLariRecommendations,
  linearTrendSlope,
  modelSubstitutionRecs,
  percentileRank,
  userValueRecs,
  utilizationRatio,
  zScoreLast,
} from './lari-recommendations';
import { LariRecommendationsInput } from './lari-recommendations.types';
import type { UserUtilizationRow } from '../analytics/user-value.types';
import type { ModelRate } from './model-equivalence';
import { UTILIZATION_CAVEAT } from '../analytics/user-value.util';

const OPENAI_BOOK: ModelRate[] = [
  { provider: 'openai', model: 'gpt-4o', inputUsdPerM: 2.5, outputUsdPerM: 10 },
  { provider: 'openai', model: 'gpt-4o-mini', inputUsdPerM: 0.15, outputUsdPerM: 0.6 },
];

const ANTHROPIC_BOOK: ModelRate[] = [
  { provider: 'anthropic', model: 'claude-sonnet', inputUsdPerM: 3, outputUsdPerM: 15 },
  { provider: 'anthropic', model: 'claude-haiku', inputUsdPerM: 0.8, outputUsdPerM: 4 },
];

const baseInput = (): LariRecommendationsInput => ({
  from: '2026-01-01',
  to: '2026-03-01',
  periodDays: 60,
  seatStats: { purchased: 10, active: 6 },
  subscriptionPlans: [
    {
      planId: 'p1',
      provider: 'openai',
      planName: 'Team',
      seatsPurchased: 10,
      contractMonthlyCost: 500,
      monthlyPricePerUser: 50,
      activeSeats: 6,
    },
  ],
  providerSpend: [
    { provider: 'openai', costUsd: 800, calls: 4000 },
    { provider: 'anthropic', costUsd: 200, calls: 2000 },
  ],
  dailySpend: [
    { day: '2026-02-01', costUsd: 10 },
    { day: '2026-02-02', costUsd: 12 },
    { day: '2026-02-03', costUsd: 11 },
    { day: '2026-02-04', costUsd: 13 },
    { day: '2026-02-05', costUsd: 50 },
  ],
  unmappedCostUsd: 120,
  agentEconomics: [
    {
      agentId: 'agent-a',
      costUsd: 300,
      valueUsd: 1200,
      lari: 2.5,
      confidenceScore: 80,
      recommendation: 'scale',
      topProvider: 'anthropic',
    },
    {
      agentId: 'agent-b',
      costUsd: 500,
      valueUsd: 50,
      lari: -0.8,
      confidenceScore: 65,
      recommendation: 'retire',
      topProvider: 'openai',
    },
  ],
  agentProviderSpend: [
    { agentId: 'agent-a', provider: 'anthropic', costUsd: 150 },
    { agentId: 'agent-a', provider: 'openai', costUsd: 50 },
    { agentId: 'agent-b', provider: 'openai', costUsd: 400 },
  ],
  modelUsage: [],
  priceBook: [],
});

describe('LARI recommendations — statistical ML helpers', () => {
  it('computes seat utilization', () => {
    expect(utilizationRatio(6, 10)).toBe(0.6);
    expect(utilizationRatio(0, 0)).toBe(1);
  });

  it('detects spend spikes via z-score', () => {
    const z = zScoreLast([10, 12, 11, 13, 50]);
    expect(z).toBeGreaterThan(2);
  });

  it('computes linear trend slope', () => {
    expect(linearTrendSlope([10, 20, 30])).toBeGreaterThan(0);
  });

  it('ranks efficiency percentiles', () => {
    expect(percentileRank(30, [10, 20, 30, 40])).toBe(50);
  });
});

describe('LARI recommendations — generateLariRecommendations', () => {
  it('flags unused seats with savings estimate', () => {
    const { recommendations } = generateLariRecommendations(baseInput());
    const seat = recommendations.find((r) => r.id === 'remove-unused-seats');
    expect(seat).toBeDefined();
    expect(seat!.category).toBe('seat_optimization');
    expect(seat!.estimatedSavingsUsd).toBeGreaterThan(0);
  });

  it('suggests switching to lower cost-per-call provider', () => {
    const { recommendations } = generateLariRecommendations(baseInput());
    const plan = recommendations.find((r) => r.id === 'switch-lower-cost-provider');
    expect(plan).toBeDefined();
    expect(plan!.priority).toMatch(/medium|high|critical/);
  });

  it('includes agent economics retire recommendation', () => {
    const { recommendations } = generateLariRecommendations(baseInput());
    const agent = recommendations.find((r) => r.id === 'agent-retire-agent-b');
    expect(agent).toBeDefined();
    expect(agent!.category).toBe('agent_economics');
    expect(agent!.priority).toBe('critical');
  });

  it('ranks providers by value per dollar', () => {
    const { providerRankings } = generateLariRecommendations(baseInput());
    expect(providerRankings.length).toBe(2);
    expect(providerRankings[0]!.rank).toBe(1);
    expect(providerRankings[0]!.efficiencyScore).toBeGreaterThanOrEqual(
      providerRankings[1]!.efficiencyScore,
    );
  });

  it('flags unmapped spend for attribution', () => {
    const { recommendations } = generateLariRecommendations(baseInput());
    expect(recommendations.some((r) => r.id === 'unmapped-spend')).toBe(true);
  });

  it('sorts by priority then mlScore', () => {
    const { recommendations } = generateLariRecommendations(baseInput());
    const priorities = ['critical', 'high', 'medium', 'low'];
    for (let i = 1; i < recommendations.length; i++) {
      const prev = priorities.indexOf(recommendations[i - 1]!.priority);
      const cur = priorities.indexOf(recommendations[i]!.priority);
      expect(prev).toBeLessThanOrEqual(cur);
    }
  });
});

describe('LARI recommendations — model substitution', () => {
  const periodDays = 30;

  it('proposes a cheaper same-family candidate with correct savings math', () => {
    const inputTokens = 1_000_000;
    const outputTokens = 500_000;
    const costUsd = 500;
    const recs = modelSubstitutionRecs({
      periodDays,
      priceBook: OPENAI_BOOK,
      modelUsage: [
        {
          provider: 'openai',
          model: 'gpt-4o',
          inputTokens,
          outputTokens,
          costUsd,
          calls: 100,
        },
      ],
    });
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.category).toBe('model_substitution');
    expect(rec.id).toBe('model-substitution-openai-gpt-4o');
    expect(rec.relatedEntity).toEqual({ type: 'model', id: 'openai/gpt-4o' });
    expect(rec.action).toContain('Run an offline eval of openai/gpt-4o-mini');

    const projected =
      (inputTokens * 0.15 + outputTokens * 0.6) / 1_000_000;
    const periodSavings = costUsd - projected;
    expect(rec.estimatedImpactUsd).toBe(Math.round((periodSavings + Number.EPSILON) * 100) / 100);
    expect(rec.estimatedSavingsUsd).toBe(
      Math.round((periodSavings * (30 / periodDays) + Number.EPSILON) * 100) / 100,
    );
  });

  it('never proposes cross-family substitutions', () => {
    const recs = modelSubstitutionRecs({
      periodDays,
      priceBook: [...OPENAI_BOOK, ...ANTHROPIC_BOOK],
      modelUsage: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-20241022',
          inputTokens: 2_000_000,
          outputTokens: 500_000,
          costUsd: 800,
          calls: 200,
        },
      ],
    });
    expect(recs.every((r) => !r.action.includes('openai/'))).toBe(true);
    if (recs.length > 0) {
      expect(recs[0]!.action).toContain('claude-haiku');
    }
  });

  it('skips models below the spend noise floor', () => {
    const recs = modelSubstitutionRecs({
      periodDays,
      priceBook: OPENAI_BOOK,
      modelUsage: [
        {
          provider: 'openai',
          model: 'gpt-4o',
          inputTokens: 100_000,
          outputTokens: 50_000,
          costUsd: 24.99,
          calls: 10,
        },
      ],
    });
    expect(recs).toHaveLength(0);
  });

  it('computes savings against cache-discounted actual cost', () => {
    const inputTokens = 20_000_000;
    const outputTokens = 0;
    const listCost = (inputTokens * 2.5) / 1_000_000;
    const cacheDiscountedCost = listCost * 0.5;
    const recs = modelSubstitutionRecs({
      periodDays,
      priceBook: OPENAI_BOOK,
      modelUsage: [
        {
          provider: 'openai',
          model: 'gpt-4o',
          inputTokens,
          outputTokens,
          costUsd: cacheDiscountedCost,
          calls: 50,
        },
      ],
    });
    expect(recs).toHaveLength(1);
    const projectedMini = (inputTokens * 0.15) / 1_000_000;
    const expectedPeriodSavings = cacheDiscountedCost - projectedMini;
    expect(recs[0]!.estimatedImpactUsd).toBe(
      Math.round((expectedPeriodSavings + Number.EPSILON) * 100) / 100,
    );
  });

  it('includes model substitution savings in summary and orders deterministically', () => {
    const input: LariRecommendationsInput = {
      ...baseInput(),
      periodDays: 30,
      priceBook: OPENAI_BOOK,
      modelUsage: [
        {
          provider: 'openai',
          model: 'gpt-4o-small-spend',
          inputTokens: 200_000,
          outputTokens: 100_000,
          costUsd: 30,
          calls: 20,
        },
        {
          provider: 'openai',
          model: 'gpt-4o',
          inputTokens: 2_000_000,
          outputTokens: 1_000_000,
          costUsd: 600,
          calls: 300,
        },
      ],
    };
    // gpt-4o-small-spend won't match price book — only gpt-4o should qualify
    input.priceBook = [
      ...OPENAI_BOOK,
      { provider: 'openai', model: 'gpt-4o', inputUsdPerM: 2.5, outputUsdPerM: 10 },
    ];

    const first = generateLariRecommendations(input);
    const second = generateLariRecommendations(input);
    expect(first.recommendations).toEqual(second.recommendations);

    const subRecs = first.recommendations.filter((r) => r.category === 'model_substitution');
    expect(subRecs.length).toBeLessThanOrEqual(3);
    if (subRecs.length >= 2) {
      expect(subRecs[0]!.estimatedSavingsUsd!).toBeGreaterThanOrEqual(
        subRecs[1]!.estimatedSavingsUsd!,
      );
    }

    const subSavings = subRecs.reduce((s, r) => s + (r.estimatedSavingsUsd ?? 0), 0);
    const totalFromRecs = first.recommendations.reduce(
      (s, r) => s + (r.estimatedSavingsUsd ?? 0),
      0,
    );
    expect(totalFromRecs).toBeGreaterThanOrEqual(subSavings);
  });
});

describe('LARI recommendations — user value (platform usage)', () => {
  const inactiveUser = (overrides: Partial<UserUtilizationRow> = {}) => ({
    userId: 'user-1',
    displayName: 'Alex',
    providers: ['cursor'],
    costUsd: 0,
    calls: 0,
    activeDays: 0,
    codingAgentCostUsd: 0,
    sessions: 0,
    utilizationScore: 0,
    seatMonthlyCostUsd: 40,
    status: 'inactive' as const,
    hasSeat: true,
    planId: 'plan-a',
    planName: 'Cursor Team',
    seatProvider: 'cursor',
    ...overrides,
  });

  it('team mode aggregates unused seats per plan', () => {
    const recs = userValueRecs({
      periodDays: 30,
      perUserMode: 'team',
      userUtilization: [
        inactiveUser(),
        inactiveUser({ userId: 'user-2', displayName: 'Blake' }),
        inactiveUser({
          userId: 'user-3',
          displayName: 'Casey',
          planId: 'plan-b',
          planName: 'Copilot Business',
          seatProvider: 'github_copilot',
          seatMonthlyCostUsd: 19,
        }),
      ],
    });
    expect(recs).toHaveLength(2);
    const cursorRec = recs.find((r) => r.id === 'unused-platform-plan-a');
    expect(cursorRec).toBeDefined();
    expect(cursorRec!.category).toBe('user_value');
    expect(cursorRec!.estimatedSavingsUsd).toBe(80);
    expect(cursorRec!.evidence).toContain(UTILIZATION_CAVEAT);
    expect(cursorRec!.relatedEntity?.type).toBe('plan');
  });

  it('individual mode emits per-user unused seat recs capped at 5', () => {
    const users = Array.from({ length: 8 }, (_, i) =>
      inactiveUser({
        userId: `user-${i}`,
        displayName: `User ${i}`,
        seatMonthlyCostUsd: 50 - i,
      }),
    );
    const recs = userValueRecs({
      periodDays: 30,
      perUserMode: 'individual',
      userUtilization: users,
    });
    expect(recs).toHaveLength(5);
    expect(recs.every((r) => r.category === 'user_value')).toBe(true);
    expect(recs[0]!.estimatedSavingsUsd).toBeGreaterThanOrEqual(recs[4]!.estimatedSavingsUsd!);
    expect(recs.every((r) => r.evidence.includes(UTILIZATION_CAVEAT))).toBe(true);
  });

  it('detects inactive seat assignments with zero activity', () => {
    const recs = userValueRecs({
      periodDays: 30,
      perUserMode: 'individual',
      userUtilization: [inactiveUser()],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0]!.title).toContain('Unused platform access');
    expect(recs[0]!.relatedEntity).toEqual({ type: 'user', id: 'user-1' });
  });

  it('cost-without-activity anomaly only in individual mode', () => {
    const spikeUser = inactiveUser({
      status: 'low_use',
      calls: 5,
      sessions: 0,
      costUsd: 200,
      dailyCost: [10, 12, 11, 13, 12, 11, 80],
      dailyCalls: [5, 5, 4, 5, 4, 3, 2],
    });
    const teamRecs = userValueRecs({
      periodDays: 30,
      perUserMode: 'team',
      userUtilization: [spikeUser],
    });
    expect(teamRecs.some((r) => r.id.startsWith('cost-without-activity'))).toBe(false);

    const individualRecs = userValueRecs({
      periodDays: 30,
      perUserMode: 'individual',
      userUtilization: [spikeUser],
    });
    const anomaly = individualRecs.find((r) => r.id.startsWith('cost-without-activity'));
    expect(anomaly).toBeDefined();
    expect(zScoreLast(spikeUser.dailyCost!)).toBeGreaterThan(3);
    expect(anomaly!.evidence).toContain(UTILIZATION_CAVEAT);
  });

  it('rolls user_value savings into generateLariRecommendations summary', () => {
    const input: LariRecommendationsInput = {
      ...baseInput(),
      perUserMode: 'team',
      userUtilization: [inactiveUser(), inactiveUser({ userId: 'user-2', displayName: 'Blake' })],
    };
    const { recommendations } = generateLariRecommendations(input);
    const userRecs = recommendations.filter((r) => r.category === 'user_value');
    expect(userRecs.length).toBeGreaterThan(0);
    const total = recommendations.reduce((s, r) => s + (r.estimatedSavingsUsd ?? 0), 0);
    const userSavings = userRecs.reduce((s, r) => s + (r.estimatedSavingsUsd ?? 0), 0);
    expect(total).toBeGreaterThanOrEqual(userSavings);
  });
});
