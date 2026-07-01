import {
  generateLariRecommendations,
  linearTrendSlope,
  percentileRank,
  utilizationRatio,
  zScoreLast,
} from './lari-recommendations';
import { LariRecommendationsInput } from './lari-recommendations.types';

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
