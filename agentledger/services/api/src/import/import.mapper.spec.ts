import { ImportRowError, mapRow } from './import.mapper';

describe('import mapRow', () => {
  it('maps a usage row to a single llm_calls event', () => {
    const { events } = mapRow({
      provider: 'openai',
      model: 'gpt-4o',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.012,
      team_id: 't1',
      agent_id: 'a1',
      run_id: 'r1',
    });
    expect(events).toHaveLength(1);
    expect(events[0].table).toBe('llm_calls');
    expect(events[0].row).toMatchObject({
      provider: 'openai',
      request_model: 'gpt-4o',
      response_model: 'gpt-4o',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.012,
      team_id: 't1',
      agent_id: 'a1',
      run_id: 'r1',
      status: 'ok',
      dlp_action: 'allow',
    });
  });

  it('rounds fractional token counts', () => {
    const { events } = mapRow({ model: 'gpt-4o', input_tokens: 10.7, output_tokens: 2.2 });
    expect(events[0].row).toMatchObject({ input_tokens: 11, output_tokens: 2 });
  });

  it('maps an outcome row to an outcomes event with asserted full confidence by default', () => {
    const { events } = mapRow({ outcome_type: 'merged_pr', outcome_value_usd: 250, run_id: 'r1' });
    expect(events).toHaveLength(1);
    expect(events[0].table).toBe('outcomes');
    expect(events[0].row).toMatchObject({
      outcome_type: 'merged_pr',
      business_value_usd: 250,
      run_id: 'r1',
      source_system: 'import',
      attribution_confidence: 1,
      completion_status: 'completed',
    });
  });

  it('honours an explicit attribution_confidence on an outcome', () => {
    const { events } = mapRow({ outcome_type: 'lead', attribution_confidence: 0.4 });
    expect(events[0].row).toMatchObject({ attribution_confidence: 0.4 });
  });

  it('rejects an attribution_confidence above 1 (probability feeding ROI)', () => {
    expect(() => mapRow({ outcome_type: 'lead', attribution_confidence: 5 })).toThrow(/attribution_confidence/i);
    expect(() => mapRow({ outcome_type: 'lead', attribution_confidence: -0.1 })).toThrow(/>= 0/);
  });

  it('maps a tool_name row to an agent_tool_calls event', () => {
    const { events } = mapRow({ tool_name: 'search', agent_id: 'a1', run_id: 'r1' });
    expect(events).toHaveLength(1);
    expect(events[0].table).toBe('agent_tool_calls');
    expect(events[0].row).toMatchObject({ tool_name: 'search', agent_id: 'a1', run_id: 'r1' });
  });

  it('maps a standalone risk signal to a risk_events row (critical → high)', () => {
    const { events } = mapRow({ risk_severity: 'critical', agent_id: 'a1', run_id: 'r1' });
    expect(events).toHaveLength(1);
    expect(events[0].table).toBe('risk_events');
    expect(events[0].row).toMatchObject({ severity: 'high', category: 'imported', agent_id: 'a1' });
  });

  it('folds a risk severity on a usage row into the llm_calls row (no separate risk_event)', () => {
    const { events } = mapRow({ model: 'gpt-4o', input_tokens: 5, risk_severity: 'high' });
    expect(events).toHaveLength(1);
    expect(events[0].table).toBe('llm_calls');
    expect(events[0].row).toMatchObject({ dlp_action: 'warn', risk_severity: 'high' });
  });

  it('emits multiple events when a row carries several signals', () => {
    const { events } = mapRow({
      model: 'gpt-4o',
      input_tokens: 5,
      tool_name: 'search',
      outcome_type: 'merged_pr',
    });
    const tables = events.map((e) => e.table).sort();
    expect(tables).toEqual(['agent_tool_calls', 'llm_calls', 'outcomes']);
  });

  it('threads the idempotency_key through and derives deterministic ids from it', () => {
    const a = mapRow({ idempotency_key: 'k1', model: 'gpt-4o', input_tokens: 1 });
    const b = mapRow({ idem_key: 'k1', model: 'gpt-4o', input_tokens: 1 });
    expect(a.idempotencyKey).toBe('k1');
    expect(b.idempotencyKey).toBe('k1');
    expect(a.events[0].row.call_id).toBe(b.events[0].row.call_id);
  });

  it('rejects a row with no importable fields', () => {
    expect(() => mapRow({ team_id: 't1' })).toThrow(ImportRowError);
    expect(() => mapRow({ team_id: 't1' })).toThrow(/no importable fields/i);
  });

  it('rejects a non-object row', () => {
    expect(() => mapRow([1, 2, 3])).toThrow(ImportRowError);
    expect(() => mapRow('nope')).toThrow(/not a JSON object/i);
  });

  it('rejects an invalid risk_severity', () => {
    expect(() => mapRow({ risk_severity: 'apocalyptic' })).toThrow(/risk_severity/i);
  });

  it('rejects a negative numeric field', () => {
    expect(() => mapRow({ model: 'gpt-4o', input_tokens: -1 })).toThrow(/>= 0/);
  });

  it('rejects a non-numeric numeric field', () => {
    expect(() => mapRow({ model: 'gpt-4o', cost_usd: 'free' })).toThrow(/must be a number/i);
  });

  it('rejects an invalid timestamp', () => {
    expect(() => mapRow({ model: 'gpt-4o', input_tokens: 1, timestamp: 'not-a-date' })).toThrow(/date\/time/i);
  });

  it('stamps metered_cost_usd and excludes price-book estimates', () => {
    const { events } = mapRow({
      provider: 'openai',
      model: 'gpt-4o',
      cost_usd: 1.25,
      cost_source: 'pricebook_estimate',
      metered_cost_usd: 0,
    });
    expect(events[0].row).toMatchObject({
      cost_usd: 1.25,
      cost_source: 'pricebook_estimate',
      metered_cost_usd: 0,
    });
  });

  it('includes provider-reported costs in metered_cost_usd', () => {
    const { events } = mapRow({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      cost_usd: 3.5,
      cost_source: 'anthropic_cost_report',
    });
    expect(events[0].row).toMatchObject({
      metered_cost_usd: 3.5,
      cost_source: 'anthropic_cost_report',
    });
  });
});
