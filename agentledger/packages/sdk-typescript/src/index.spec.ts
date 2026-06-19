import { flush, init, startRun, withRun } from './index';

type Captured = { url: string; init: RequestInit };

function mockFetch(): { calls: Captured[] } {
  const calls: Captured[] = [];
  global.fetch = jest.fn((url: string | URL | Request, reqInit?: RequestInit) => {
    calls.push({ url: String(url), init: reqInit ?? {} });
    return Promise.resolve(new Response(null, { status: 202 }));
  }) as unknown as typeof fetch;
  return { calls };
}

const bodyOf = (c: Captured): Record<string, unknown> => JSON.parse(String(c.init.body));

const CFG = { collectorUrl: 'http://collector.test/v1/events', tenantId: 't1', appId: 'app-x', apiKey: 'secret-key' };

describe('AgentLedger TS SDK', () => {
  // Runs first, before any init() below, so module-level config is still null.
  it('startRun before init() throws', () => {
    expect(() => startRun('a')).toThrow(/init/);
  });

  it('recordLlmCall posts an llm_call with auth + counters', async () => {
    const { calls } = mockFetch();
    init(CFG);
    const run = startRun('ticket-triage', 'triage #1');
    run.recordLlmCall({ provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50, costUsd: 0.0012, cacheReadTokens: 10 });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CFG.collectorUrl);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
    const b = bodyOf(calls[0]);
    expect(b.kind).toBe('llm_call');
    expect(String(b.call_id)).toMatch(/^call_[0-9a-f]{16}$/);
    expect(b).toMatchObject({
      tenant_id: 't1',
      app_id: 'app-x',
      agent_id: 'ticket-triage',
      run_id: run.runId,
      step_id: 'step_1',
      provider: 'openai',
      request_model: 'gpt-4o',
      operation_name: 'chat',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      status: 'ok',
      source: 'sdk',
    });
  });

  it('recordToolCall + recordOutcome shapes; outcome returns an id', async () => {
    const { calls } = mockFetch();
    init(CFG);
    const run = startRun('agent');
    run.recordToolCall({ toolName: 'fetch_ticket', latencyMs: 12 });
    const outcomeId = run.recordOutcome({ outcomeType: 'ticket_resolved', sourceSystem: 'zendesk', ref: '4812', businessValueUsd: 18.5, attributionConfidence: 0.9 });
    await flush();

    expect(outcomeId).toMatch(/^out_[0-9a-f]{16}$/);
    const tool = bodyOf(calls[0]);
    expect(tool).toMatchObject({ kind: 'tool_call', operation_name: 'execute_tool', tool_name: 'fetch_ticket', status: 'ok', latency_ms: 12, source: 'sdk' });
    const outcome = bodyOf(calls[1]);
    expect(outcome).toMatchObject({ kind: 'outcome', outcome_id: outcomeId, outcome_type: 'ticket_resolved', source_system: 'zendesk', ref: '4812', business_value_usd: 18.5, attribution_confidence: 0.9, completion_status: 'completed' });
  });

  it('end() emits agent_run with rolled-up counters and incrementing steps', async () => {
    const { calls } = mockFetch();
    init(CFG);
    const run = startRun('agent', 'do work');
    run.recordLlmCall({ provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 5, costUsd: 1.0 });
    run.recordLlmCall({ provider: 'openai', model: 'gpt-4o', inputTokens: 20, outputTokens: 5, costUsd: 2.0 });
    run.recordToolCall({ toolName: 't' });
    run.end();
    await flush();

    // step_id increments across calls (two llm + one tool => steps 1,2,3).
    expect(bodyOf(calls[0]).step_id).toBe('step_1');
    expect(bodyOf(calls[1]).step_id).toBe('step_2');
    expect(bodyOf(calls[2]).step_id).toBe('step_3');

    const close = bodyOf(calls[3]);
    expect(close).toMatchObject({
      kind: 'agent_run',
      run_id: run.runId,
      status: 'completed',
      llm_calls: 2,
      tool_calls: 1,
      total_cost_usd: 3.0,
      total_tokens: 40,
    });
    expect(String(close.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('withRun closes on success and marks failed + rethrows on error', async () => {
    const { calls } = mockFetch();
    init(CFG);

    await withRun('agent', 'ok-run', async (run) => {
      run.recordToolCall({ toolName: 't' });
    });
    await flush();
    expect(bodyOf(calls[calls.length - 1])).toMatchObject({ kind: 'agent_run', status: 'completed' });

    const before = calls.length;
    await expect(
      withRun('agent', 'bad-run', async () => {
        throw new TypeError('boom');
      }),
    ).rejects.toThrow('boom');
    await flush();
    const close = bodyOf(calls[calls.length - 1]);
    expect(close.kind).toBe('agent_run');
    expect(close.status).toBe('failed');
    expect(String(close.objective)).toContain('[failed: TypeError]');
    expect(calls.length).toBeGreaterThan(before);
  });

  it('swallows transport errors (never throws into the host)', async () => {
    mockFetch();
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    init(CFG);
    const run = startRun('agent');
    expect(() => run.recordLlmCall({ provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1 })).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
  });
});
