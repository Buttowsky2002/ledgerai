import { buildPlatformBreakdown, costBasisLabel, inferCostBasis } from './platform-breakdown';

describe('platform-breakdown', () => {
  it('tags cursor as subscription and openai as usage', () => {
    expect(inferCostBasis('cursor')).toBe('subscription');
    expect(inferCostBasis('github_copilot_business')).toBe('subscription');
    expect(inferCostBasis('openai')).toBe('usage');
    expect(costBasisLabel('usage')).toBe('(usage)');
  });

  it('nests models under platforms and surfaces remainder', () => {
    const platforms = buildPlatformBreakdown(
      [
        { provider: 'openai', costUsd: 100, calls: 10 },
        { provider: 'cursor', costUsd: 50, calls: 2 },
      ],
      [
        { provider: 'openai', model: 'gpt-4o', costUsd: 60, calls: 6 },
        { provider: 'openai', model: 'gpt-4o-mini', costUsd: 35, calls: 3 },
        { provider: 'cursor', model: 'default', costUsd: 50, calls: 2 },
      ],
    );
    const openai = platforms.find((p) => p.provider === 'openai');
    expect(openai?.models).toHaveLength(2);
    expect(openai?.remainderUsd).toBe(5);
    expect(platforms.find((p) => p.provider === 'cursor')?.costBasis).toBe('subscription');
  });
});
