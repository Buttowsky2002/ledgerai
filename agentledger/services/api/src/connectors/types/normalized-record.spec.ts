import { toImportRow } from './normalized-record';
import { mapRow } from '../../import/import.mapper';

describe('normalized-record pipeline', () => {
  it('converts normalized records to import rows that map to llm_calls', () => {
    const row = toImportRow({
      tenant_id: 't1',
      source: 'api',
      source_type: 'ai_usage',
      connector_id: 'c1',
      connector_sync_run_id: 's1',
      provider: 'openai',
      record_type: 'llm_call_record',
      ts: '2026-01-15T00:00:00.000Z',
      lineage: { dedupe_hash: 'abc123', external_record_id: 'ext-1' },
      metrics: { model: 'gpt-4o', input_tokens: 100, output_tokens: 50, cost_usd: 1.5 },
    });
    const { events } = mapRow(row);
    expect(events[0].table).toBe('llm_calls');
    expect(events[0].row).toMatchObject({
      request_model: 'gpt-4o',
      input_tokens: 100,
      cost_usd: 1.5,
      source: 'api',
    });
  });
});
