import {
  COPILOT_ANALYTICS_PLATFORM,
  type CopilotSpendSummary,
} from '../github-copilot/github-copilot-analytics.service';
import { mergeProviderSpendRows, supplementalConnectorSpend } from './lari-connector-spend';

describe('lari-connector-spend', () => {
  it('merges copilot connector spend into provider rollups', () => {
    const copilot: CopilotSpendSummary = {
      totalCostUsd: 1200,
      estimatedValueUsd: 800,
      totalCalls: 500,
      daily: [],
      modelMix: [],
      platform: { platform: COPILOT_ANALYTICS_PLATFORM, cost_usd: 1200, calls: 500 },
    };

    const { providerSpend, spendBySource } = supplementalConnectorSpend(copilot, null, []);
    const merged = mergeProviderSpendRows([], providerSpend);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.provider).toBe(COPILOT_ANALYTICS_PLATFORM);
    expect(merged[0]!.costUsd).toBe(1200);
    expect(spendBySource.get('github copilot')?.connectorUsd).toBe(1200);
  });

  it('dedupes when analytics store already has the same provider', () => {
    const copilot: CopilotSpendSummary = {
      totalCostUsd: 500,
      estimatedValueUsd: 200,
      totalCalls: 100,
      daily: [],
      modelMix: [],
      platform: { platform: COPILOT_ANALYTICS_PLATFORM, cost_usd: 500, calls: 100 },
    };
    const { providerSpend } = supplementalConnectorSpend(copilot, null, [
      { provider: 'GitHub Copilot', costUsd: 300, calls: 50 },
    ]);
    const merged = mergeProviderSpendRows(
      [{ provider: 'GitHub Copilot', costUsd: 300, calls: 50 }],
      providerSpend,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.costUsd).toBe(800);
    expect(merged[0]!.calls).toBe(150);
  });
});
