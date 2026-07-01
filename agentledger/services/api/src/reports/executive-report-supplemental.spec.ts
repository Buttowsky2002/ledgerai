import { COPILOT_ANALYTICS_PROVIDER } from '../github-copilot/github-copilot-analytics.service';
import { mergeCopilotSupplement, mergeProviderCostsSupplement } from './executive-report-supplemental';

describe('executive-report-supplemental', () => {
  it('adds provider_costs platforms missing from spend_daily', () => {
    const { providers, addedCostUsd } = mergeProviderCostsSupplement(
      [{ provider: 'cursor', costUsd: 100, calls: 10 }],
      [{ provider: 'openai', costUsd: 250, calls: 0 }],
    );
    expect(addedCostUsd).toBe(250);
    expect(providers.map((p) => p.provider)).toContain('openai');
  });

  it('merges GitHub Copilot into totals and provider list', () => {
    const merged = mergeCopilotSupplement(
      { costUsd: 3000, calls: 100, inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      [{ provider: 'cursor', costUsd: 3000, calls: 100 }],
      [{ provider: 'cursor', model: 'default', costUsd: 3000, calls: 100 }],
      [{ day: '2026-06-01', costUsd: 3000 }],
      {
        totalCostUsd: 1250,
        estimatedValueUsd: 0,
        totalCalls: 50,
        daily: [{ day: '2026-06-01', cost_usd: 1250 }],
        modelMix: [{ provider: COPILOT_ANALYTICS_PROVIDER, model: 'copilot-business', cost_usd: 1250, calls: 50 }],
        platform: { platform: 'GitHub Copilot', cost_usd: 1250, calls: 50 },
      },
    );
    expect(merged.current.costUsd).toBe(4250);
    expect(merged.providers.some((p) => p.provider === COPILOT_ANALYTICS_PROVIDER)).toBe(true);
  });
});
