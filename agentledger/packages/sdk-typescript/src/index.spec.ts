import { LedgerAI } from './index';

type Captured = { url: string; headers: Record<string, string>; body: string };

// A controllable fetch mock that records requests.
function mockFetch(opts: { status?: number; reject?: boolean } = {}): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fn = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: String(init?.body ?? ''),
    });
    if (opts.reject) throw new Error('network down');
    return new Response(null, { status: opts.status ?? 202 });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const lines = (body: string) => body.split('\n').filter((l) => l.trim() !== '');

// A large flush interval keeps the background timer from firing mid-test; we
// drive flushing explicitly. maxBatch high so enqueue does not auto-flush.
const base = (fetchImpl: typeof fetch, extra = {}) =>
  new LedgerAI({
    apiKey: 'test-key',
    baseUrl: 'http://collector.test',
    tenantId: 't-demo',
    flushIntervalMs: 1_000_000,
    maxBatch: 1000,
    maxRetries: 0,
    fetch: fetchImpl,
    ...extra,
  });

describe('LedgerAI SDK', () => {
  it('sends buffered events to {baseUrl}/v1/events with auth, and emits the run record', async () => {
    const { fetch, calls } = mockFetch();
    const ledger = base(fetch);

    await ledger.run({ agentId: 'support-bot' }, async (run) => {
      await run.llmCall({ provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50, costUsd: 0.0012 });
      await run.toolCall({ tool: 'search_kb' });
      await run.outcome({ type: 'ticket_resolved', sourceSystem: 'zendesk', valueUsd: 18.5, attributionConfidence: 0.9 });
    });
    await ledger.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://collector.test/v1/events');
    expect(calls[0].headers.Authorization).toBe('Bearer test-key');

    const evs = lines(calls[0].body).map((l) => JSON.parse(l));
    const kinds = evs.map((e) => e.kind);
    expect(kinds).toEqual(['llm_call', 'tool_call', 'outcome', 'agent_run']);

    const llm = evs[0];
    expect(llm).toMatchObject({
      kind: 'llm_call',
      tenant_id: 't-demo',
      provider: 'openai',
      request_model: 'gpt-4o',
      input_tokens: 100,
      output_tokens: 50,
      status: 'ok',
      source: 'sdk',
    });
    expect(String(llm.call_id)).toMatch(/^call_/);
    expect(evs[3]).toMatchObject({ kind: 'agent_run', status: 'completed', llm_calls: 1, tool_calls: 1 });

    await ledger.shutdown();
  });

  it('fail-open (default) does not throw when the sink is unreachable', async () => {
    const { fetch } = mockFetch({ reject: true });
    const ledger = base(fetch); // failOpen defaults to true
    ledger.llmCall({ provider: 'openai', model: 'gpt-4o', agentId: 'a', runId: 'r' });
    await expect(ledger.flush()).resolves.toBeUndefined();
    await ledger.shutdown();
  });

  it('fail-closed surfaces the transport error from flush()', async () => {
    const { fetch } = mockFetch({ reject: true });
    const ledger = base(fetch, { failOpen: false });
    ledger.llmCall({ provider: 'openai', model: 'gpt-4o', agentId: 'a', runId: 'r' });
    await expect(ledger.flush()).rejects.toThrow(/network down/);
  });

  it('fail-closed surfaces a non-2xx response', async () => {
    const { fetch } = mockFetch({ status: 422 });
    const ledger = base(fetch, { failOpen: false });
    ledger.toolCall({ tool: 't', agentId: 'a', runId: 'r' });
    await expect(ledger.flush()).rejects.toThrow(/422/);
  });

  it('batches multiple events into a single request', async () => {
    const { fetch, calls } = mockFetch();
    const ledger = base(fetch);
    for (let i = 0; i < 5; i++) {
      ledger.toolCall({ tool: `t${i}`, agentId: 'a', runId: 'r' });
    }
    await ledger.flush();
    expect(calls).toHaveLength(1);
    expect(lines(calls[0].body)).toHaveLength(5);
    await ledger.shutdown();
  });

  it('flushes remaining events on shutdown', async () => {
    const { fetch, calls } = mockFetch();
    const ledger = base(fetch);
    ledger.outcome({ type: 'pr_merged', sourceSystem: 'github', valueUsd: 250, agentId: 'a', runId: 'r' });
    expect(calls).toHaveLength(0); // nothing sent yet
    await ledger.shutdown();
    expect(calls).toHaveLength(1);
    expect(lines(calls[0].body)).toHaveLength(1);
  });

  it('never sends raw content unless contentCapture is explicitly enabled', async () => {
    // Default: content keys are stripped.
    const off = mockFetch();
    const a = base(off.fetch);
    a.trackAction({ action: 'summarize', agentId: 'a', runId: 'r', attributes: { prompt: 'SECRET PROMPT', content: 'SECRET', tool_version: 2 } });
    await a.flush();
    expect(off.calls[0].body).not.toContain('SECRET');
    const ev = JSON.parse(lines(off.calls[0].body)[0]);
    expect(ev.prompt).toBeUndefined();
    expect(ev.content).toBeUndefined();
    expect(ev.tool_version).toBe(2); // non-content attributes pass through
    await a.shutdown();

    // Explicit opt-in: content is included.
    const on = mockFetch();
    const b = base(on.fetch, { contentCapture: true });
    b.trackAction({ action: 'summarize', agentId: 'a', runId: 'r', attributes: { prompt: 'SECRET PROMPT' } });
    await b.flush();
    expect(on.calls[0].body).toContain('SECRET PROMPT');
    await b.shutdown();
  });

  it('the user error from run() propagates while the run record is still emitted (failed)', async () => {
    const { fetch, calls } = mockFetch();
    const ledger = base(fetch);
    await expect(
      ledger.run({ agentId: 'a' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await ledger.flush();
    const evs = lines(calls[0].body).map((l) => JSON.parse(l));
    expect(evs[evs.length - 1]).toMatchObject({ kind: 'agent_run', status: 'failed' });
    await ledger.shutdown();
  });
});
