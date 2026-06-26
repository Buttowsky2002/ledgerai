import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyAnthropicKeyRouting } from '../anthropic-key-routing';
import { extractPage } from '../engine/pagination';
import { mapFields, validateMetrics } from '../engine/field-mapper';
import { enrichRecordCost } from '../cost-estimator';
import type { ConnectorDefinition } from '../types/connector-definition';

function loadPreset(): ConnectorDefinition {
  return JSON.parse(
    readFileSync(join(__dirname, 'anthropic-usage.json'), 'utf8'),
  ) as ConnectorDefinition;
}

describe('anthropic-usage preset', () => {
  const preset = loadPreset();

  it('uses Admin cost_report with workspace + description grouping and usage supplemental fetch', () => {
    expect(preset.endpoints[0].path).toBe('/v1/organizations/cost_report');
    expect(preset.endpoints[0].queryParamArrays?.['group_by[]']).toEqual([
      'workspace_id',
      'description',
    ]);
    expect(preset.pagination?.flattenPath).toBe('results');
    expect(preset.pagination?.hasMorePath).toBe('has_more');
    expect(preset.pagination?.tokenPath).toBe('next_page');
    expect(preset.supplementalFetch?.endpoint.path).toBe(
      '/v1/organizations/usage_report/messages',
    );
    expect(preset.supplementalFetch?.endpoint.queryParamArrays?.['group_by[]']).toEqual([
      'workspace_id',
      'model',
    ]);
    expect(preset.supplementalFetch?.mergeOn).toEqual(['period_start', 'model', 'workspace_id']);
  });

  it('paginates with has_more and next_page', () => {
    const rawResponse = {
      data: [{ starting_at: '2026-06-01T00:00:00Z', results: [{ model: 'claude-opus-4-6' }] }],
      has_more: true,
      next_page: 'page-token-abc',
    };
    const page = extractPage(rawResponse, preset.pagination);
    expect(page.hasMore).toBe(true);
    expect(page.nextToken).toBe('page-token-abc');
  });

  it('maps cost_report cents to USD with workspace and model', () => {
    const rawResponse = {
      data: [
        {
          starting_at: '2026-06-01T00:00:00Z',
          ending_at: '2026-06-02T00:00:00Z',
          results: [
            {
              amount: '5000',
              currency: 'USD',
              model: 'claude-opus-4-6',
              workspace_id: 'wrkspc_test',
              description: 'Tokens',
              cost_type: 'tokens',
            },
          ],
        },
      ],
      has_more: false,
    };

    const page = extractPage(rawResponse, preset.pagination);
    expect(page.items).toHaveLength(1);

    const { metrics } = mapFields(page.items[0], preset.fieldMappings);
    const errors = validateMetrics(metrics, preset.validationRules);
    expect(errors).toEqual([]);
    expect(metrics.cost_usd).toBeCloseTo(50, 2);
    expect(metrics.provider).toBe('anthropic');
    expect(metrics.workspace_id).toBe('wrkspc_test');
    expect(metrics.model).toBe('claude-opus-4-6');

    const enriched = enrichRecordCost({ ...metrics, provider: 'anthropic' });
    expect(enriched.cost_usd).toBeCloseTo(50, 2);
  });

  it('maps usage_report token fields for supplemental merge', () => {
    const usageRow = {
      starting_at: '2026-06-01T00:00:00Z',
      model: 'claude-opus-4-6',
      workspace_id: 'wrkspc_test',
      uncached_input_tokens: 1000,
      cache_read_input_tokens: 200,
      output_tokens: 500,
    };
    const { metrics } = mapFields(usageRow, preset.supplementalFetch!.fieldMappings);
    expect(metrics.input_tokens).toBe(1200);
    expect(metrics.output_tokens).toBe(500);
    expect(metrics.period_start).toBe('2026-06-01T00:00:00Z');
  });

  it('routes non-admin keys to analytics user_cost_report', () => {
    const routed = applyAnthropicKeyRouting(preset, 'sk-ant-api03-example');
    expect(routed.endpoints[0].path).toBe('/v1/organizations/analytics/user_cost_report');
  });

  it('keeps cost_report for sk-ant-admin keys', () => {
    const routed = applyAnthropicKeyRouting(preset, 'sk-ant-admin-example');
    expect(routed.endpoints[0].path).toBe('/v1/organizations/cost_report');
    expect(routed.supplementalFetch?.endpoint.path).toBe(
      '/v1/organizations/usage_report/messages',
    );
  });
});
