import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractPage } from '../engine/pagination';
import { mapFields, validateMetrics } from '../engine/field-mapper';
import { buildTemplateContext } from '../engine/sync-context';
import type { ConnectorDefinition } from '../types/connector-definition';
import type { SyncContext } from '../engine/connector-engine';

function loadPreset(): ConnectorDefinition {
  return JSON.parse(readFileSync(join(__dirname, 'cursor-usage.json'), 'utf8')) as ConnectorDefinition;
}

describe('cursor-usage preset', () => {
  const preset = loadPreset();

  it('targets Cursor Admin filtered usage events', () => {
    expect(preset.provider).toBe('cursor');
    expect(preset.authType).toBe('basic_auth');
    expect(preset.endpoints[0].path).toBe('/teams/filtered-usage-events');
    expect(preset.endpoints[0].method).toBe('POST');
    expect(preset.capabilities?.supportsUserLevelCost).toBe(true);
  });

  it('builds POST body with unix ms date range and page', () => {
    const ctx = {
      tenantId: 'tenant-1',
      connectorId: 'conn-1',
      syncRunId: 'run-1',
      definition: preset,
      credentials: {},
      syncStart: new Date('2026-06-01T00:00:00.000Z'),
      syncEnd: new Date('2026-06-07T00:00:00.000Z'),
    } as SyncContext;
    const tmpl = buildTemplateContext(ctx, { page: 2, page_size: 100 });
    const body = preset.endpoints[0].bodyTemplate!
      .replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(tmpl[key as keyof typeof tmpl] ?? ''));
    const parsed = JSON.parse(body) as Record<string, number>;
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(100);
    expect(parsed.startDate).toBeLessThan(parsed.endDate);
  });

  it('maps usage events to user email and chargedCents USD', () => {
    const rawResponse = {
      usageEvents: [
        {
          timestamp: '1750979225854',
          userEmail: 'developer@company.com',
          model: 'claude-4.5-sonnet',
          kind: 'Usage-based',
          chargedCents: 20.18232,
          tokenUsage: { inputTokens: 126, outputTokens: 450 },
        },
      ],
      pagination: { hasNextPage: false, currentPage: 1, pageSize: 100 },
    };

    const page = extractPage(rawResponse, preset.pagination);
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);

    const { metrics } = mapFields(page.items[0], preset.fieldMappings);
    const errors = validateMetrics(metrics, preset.validationRules);
    expect(errors).toEqual([]);
    expect(metrics.user_email).toBe('developer@company.com');
    expect(metrics.user_id).toBe('developer@company.com');
    expect(metrics.cost_usd).toBeCloseTo(0.2018232, 5);
    expect(metrics.input_tokens).toBe(126);
    expect(metrics.provider).toBe('cursor');
  });
});
