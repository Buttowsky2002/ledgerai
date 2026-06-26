import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyAnthropicKeyRouting } from './anthropic-key-routing';
import type { ConnectorDefinition } from './types/connector-definition';

function loadPreset(): ConnectorDefinition {
  return JSON.parse(
    readFileSync(join(__dirname, 'presets/anthropic-usage.json'), 'utf8'),
  ) as ConnectorDefinition;
}

describe('applyAnthropicKeyRouting', () => {
  const preset = loadPreset();

  it('returns definition unchanged for non-anthropic providers', () => {
    const other = { ...preset, provider: 'openai', id: 'openai-usage' };
    expect(applyAnthropicKeyRouting(other, 'sk-ant-api03')).toBe(other);
  });

  it('uses cost_report for admin keys and empty secrets', () => {
    expect(applyAnthropicKeyRouting(preset, 'sk-ant-admin01-abc').endpoints[0].path).toBe(
      '/v1/organizations/cost_report',
    );
    expect(applyAnthropicKeyRouting(preset, '').endpoints[0].path).toBe(
      '/v1/organizations/cost_report',
    );
  });

  it('swaps to analytics endpoint for non-admin anthropic keys', () => {
    const routed = applyAnthropicKeyRouting(preset, 'sk-ant-api03-xyz');
    expect(routed.endpoints[0].path).toBe('/v1/organizations/analytics/user_cost_report');
    expect(routed.fallbackDefinition?.endpoints?.[0].path).toBe('/v1/organizations/cost_report');
  });
});
