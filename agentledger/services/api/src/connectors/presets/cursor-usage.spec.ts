import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractPage } from '../engine/pagination';
import { mapFields, validateMetrics } from '../engine/field-mapper';
import { buildTemplateContext } from '../engine/sync-context';
import { finalizeConnectorRecord } from '../connector-record-pipeline';
import type { ConnectorDefinition } from '../types/connector-definition';
import type { SyncContext } from '../engine/connector-engine';
import type { NormalizedRecord } from '../types/normalized-record';

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
    expect(preset.capabilities?.supportsUsers).toBe(true);
  });

  it('includes companion fetch for daily code activity', () => {
    expect(preset.companionFetches).toHaveLength(1);
    const companion = preset.companionFetches![0];
    expect(companion.id).toBe('codingActivity');
    expect(companion.destinationRecordType).toBe('coding_activity_record');
    expect(companion.endpoint.path).toBe('/teams/daily-usage-data');
    expect(companion.pagination?.itemsPath).toBe('data');
    expect(companion.pagination?.type).toBe('page');
    const toolName = companion.fieldMappings.find(
      (m) => m.type === 'constant' && m.target === 'tool_name',
    );
    expect(toolName && toolName.type === 'constant' ? toolName.value : undefined).toBe('cursor-usage');
  });

  it('maps daily usage rows to coding activity metrics', () => {
    const companion = preset.companionFetches![0];
    const raw = {
      email: 'developer@company.com',
      day: '2026-06-15',
      acceptedLinesAdded: 120,
      acceptedLinesDeleted: 30,
      totalLinesAdded: 200,
      totalLinesDeleted: 50,
      totalTabsAccepted: 42,
      composerRequests: 10,
      chatRequests: 25,
    };
    const { metrics } = mapFields(raw, companion.fieldMappings);
    const errors = validateMetrics(metrics, companion.validationRules);
    expect(errors).toEqual([]);
    expect(metrics.user_email).toBe('developer@company.com');
    expect(metrics.lines_accepted).toBe(150);
    expect(metrics.lines_committed).toBe(200);
    expect(metrics.tabs_accepted).toBe(42);
    expect(metrics.composer_requests).toBe(10);
    expect(metrics.chat_requests).toBe(25);
    expect(metrics.tool_name).toBe('cursor-usage');
    expect(metrics.provider).toBe('cursor');
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

  it('accepts zero chargedCents included usage (subscription-covered)', () => {
    const raw = {
      timestamp: '1750978339901',
      userEmail: 'developer@company.com',
      model: 'default',
      kind: 'Included',
      isChargeable: false,
      chargedCents: 0,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    };
    const { metrics } = mapFields(raw, preset.fieldMappings);
    expect(metrics.cost_usd).toBe(0);
    expect(validateMetrics(metrics, preset.validationRules)).toEqual([]);
  });

  it('splits included usage value from billed overage after finalize', () => {
    const raw = {
      timestamp: '1750978339901',
      userEmail: 'developer@company.com',
      model: 'claude-opus-4-8-thinking-high',
      kind: 'Included',
      isChargeable: false,
      chargedCents: 8,
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
    };
    const { metrics } = mapFields(raw, preset.fieldMappings);
    expect(validateMetrics(metrics, preset.validationRules)).toEqual([]);

    const rec: NormalizedRecord = {
      tenant_id: 'tenant-1',
      source: 'api',
      source_type: 'coding_tool',
      connector_id: 'conn-1',
      connector_sync_run_id: 'run-1',
      provider: 'cursor',
      record_type: 'spend_usage_record',
      ts: '2026-07-01T00:00:00.000Z',
      lineage: { dedupe_hash: 'abc', external_record_id: '1' },
      metrics,
    };
    const { record } = finalizeConnectorRecord(rec, preset, [], []);
    expect(record.metrics.usage_value_usd).toBeCloseTo(0.08, 4);
    expect(record.metrics.cost_usd).toBe(0);
    expect(record.metrics.operation_name).toBe('cursor:included');
  });

  it('uses stable dedupe hash regardless of chargedCents / billed split', () => {
    const base = {
      timestamp: '1750978339901',
      userEmail: 'developer@company.com',
      model: 'claude-opus-4-8-thinking-high',
      kind: 'On-Demand',
      isChargeable: true,
    };
    const mk = (chargedCents: number) =>
      finalizeConnectorRecord(
        {
          tenant_id: 'tenant-1',
          source: 'api',
          source_type: 'coding_tool',
          connector_id: 'conn-1',
          connector_sync_run_id: 'run-1',
          provider: 'cursor',
          record_type: 'spend_usage_record',
          ts: '2026-07-01T00:00:00.000Z',
          lineage: { dedupe_hash: 'abc', external_record_id: '1' },
          metrics: mapFields({ ...base, chargedCents }, preset.fieldMappings).metrics,
        },
        preset,
        [],
        [],
      ).record.lineage.dedupe_hash;

    expect(mk(8)).toBe(mk(20));
  });
});
