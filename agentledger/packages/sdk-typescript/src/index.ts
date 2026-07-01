/**
 * BadgerIQ TypeScript SDK.
 *
 * Dependency-free tracing for AI agents — agent runs, LLM calls, tool calls,
 * business outcomes, and risk signals — sent to the BadgerIQ collector
 * (`POST {baseUrl}/v1/events`). Field names track the OpenTelemetry GenAI
 * semantic conventions (gen_ai.*); see `otelLlmAttributes`.
 *
 *   const ledger = new LedgerAI({ apiKey: process.env.BADGERIQ_KEY, baseUrl: process.env.BADGERIQ_URL });
 *   await ledger.run({ agentId: 'support-bot' }, async (run) => {
 *     await run.llmCall({ provider: 'openai', model: 'gpt-4o', inputTokens: 120, outputTokens: 80, costUsd: 0.004 });
 *     await run.toolCall({ tool: 'search_kb' });
 *     await run.outcome({ type: 'ticket_resolved', sourceSystem: 'zendesk', valueUsd: 18.5, attributionConfidence: 0.9 });
 *   });
 *   await ledger.shutdown();
 *
 * Design:
 *  - Zero runtime dependencies. Browser-safe (uses global `fetch`, `crypto`,
 *    `AbortController`); defaults to Node/server use.
 *  - Telemetry is buffered and flushed in batches with bounded retries + timeout.
 *  - fail-open by default: telemetry never throws into your app. Set
 *    `failOpen: false` to surface transport errors from `flush()` / `shutdown()`.
 *  - PRIVACY: no raw prompt/response content is ever sent. The canonical event
 *    schema has no content field. `contentCapture: true` is an explicit, audited
 *    opt-in (see README) — leave it off unless you operate your own pipeline.
 */

// process is Node-only; in the browser callers pass apiKey/baseUrl explicitly.
const ENV: Record<string, string | undefined> =
  typeof process !== 'undefined' && process.env ? process.env : {};

function env(name: string): string | undefined {
  const v = ENV[name];
  return v !== undefined && v !== '' ? v : undefined;
}

// Keys that may carry raw prompt/response content — stripped from every event
// unless contentCapture is explicitly enabled (defense in depth, CLAUDE.md rule 2).
const CONTENT_KEYS = ['content', 'prompt', 'completion', 'messages', 'input', 'output', 'response', 'text'];

/** Options for the LedgerAI client. */
export interface LedgerAIOptions {
  /** Ingest token. Default: env BADGERIQ_KEY (then legacy BADGERIQ_API_KEY). */
  apiKey?: string;
  /** Collector base URL. Default: env BADGERIQ_URL (then localhost:8090). */
  baseUrl?: string;
  /** Never throw on telemetry failures (default true). */
  failOpen?: boolean;
  /** Tenant id stamped on every event (required for ingestion). Default env BADGERIQ_TENANT_ID. */
  tenantId?: string;
  /** Optional default attribution dimensions. */
  appId?: string;
  userId?: string;
  environment?: string;
  /** Batch flush cadence in ms (default 2000). */
  flushIntervalMs?: number;
  /** Max events per flush / request (default 100). */
  maxBatch?: number;
  /** Per-request timeout in ms (default 10000). */
  timeoutMs?: number;
  /** Extra send attempts on transport error / 5xx (default 2). */
  maxRetries?: number;
  /**
   * Allow raw content fields through. DEFAULT FALSE. When false, known content
   * keys are stripped from every event before send. Only enable if you operate
   * your own content-capture pipeline (see README — strongly discouraged).
   */
  contentCapture?: boolean;
  /** Injected fetch (tests/browser). Default global fetch. */
  fetch?: typeof fetch;
  /** Injected clock (tests). Default Date.now. */
  now?: () => number;
  /** Optional logger for dropped telemetry (default console.warn). */
  logger?: (message: string, detail?: unknown) => void;
}

/** Identifies an agent run. */
export interface RunOptions {
  agentId: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}

/** An LLM call. Field names map to gen_ai.* — see otelLlmAttributes. */
export interface LlmCallInput {
  provider: string; // gen_ai.provider.name
  model: string; // gen_ai.request.model
  inputTokens?: number; // gen_ai.usage.input_tokens
  outputTokens?: number; // gen_ai.usage.output_tokens
  cacheReadTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  operationName?: string; // gen_ai.operation.name (default "chat")
  status?: 'ok' | 'upstream_error' | 'blocked_dlp' | 'blocked_budget' | 'blocked_rate' | 'blocked_policy' | 'blocked_tool';
  agentId?: string;
  runId?: string;
  stepId?: string;
}

export interface ToolCallInput {
  tool: string; // gen_ai.tool.name
  mcpServer?: string;
  status?: string;
  latencyMs?: number;
  agentId?: string;
  runId?: string;
  stepId?: string;
}

export interface OutcomeInput {
  type: string; // outcome_type, e.g. ticket_resolved
  sourceSystem: string; // jira|github|zendesk|manual|api
  ref?: string;
  valueUsd?: number; // business_value_usd
  qualityScore?: number;
  attributionConfidence?: number; // 0..1
  agentId?: string;
  runId?: string;
}

export interface RiskInput {
  category: string; // unauthorized_tool | tool_spike | injection_suspected | ...
  severity: 'low' | 'medium' | 'high' | 'critical';
  detail?: string;
  occurrences?: number;
  agentId?: string;
  runId?: string;
}

export interface TrackActionInput {
  action: string;
  attributes?: Record<string, unknown>;
  agentId?: string;
  runId?: string;
  stepId?: string;
}

type LedgerEvent = Record<string, unknown>;
type Ctx = { agentId?: string; runId?: string; stepId?: string };

function genId(prefix: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const id = c?.randomUUID ? c.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2).padEnd(16, '0');
  return `${prefix}_${id.slice(0, 24)}`;
}

const nonNegInt = (v: number | undefined): number => Math.max(0, Math.round(v ?? 0));

/**
 * gen_ai.* attribute map for an LLM call, for callers who also emit OpenTelemetry
 * spans. LedgerAI's own event field names already track these conventions.
 */
export function otelLlmAttributes(c: LlmCallInput): Record<string, string | number> {
  const a: Record<string, string | number> = {
    'gen_ai.provider.name': c.provider,
    'gen_ai.request.model': c.model,
    'gen_ai.operation.name': c.operationName ?? 'chat',
  };
  if (c.inputTokens != null) a['gen_ai.usage.input_tokens'] = nonNegInt(c.inputTokens);
  if (c.outputTokens != null) a['gen_ai.usage.output_tokens'] = nonNegInt(c.outputTokens);
  return a;
}

/** A live agent run. Methods inject the run's agent/run/step context. */
export class Run {
  readonly runId: string;
  status: 'completed' | 'failed' = 'completed';
  startedAtMs: number;
  llmCalls = 0;
  toolCalls = 0;
  totalCostUsd = 0;
  totalTokens = 0;
  private stepSeq = 0;

  constructor(
    private readonly client: LedgerAI,
    readonly agentId: string,
    runId: string | undefined,
    readonly metadata: Record<string, unknown> | undefined,
    startedAtMs: number,
  ) {
    this.runId = runId ?? genId('run');
    this.startedAtMs = startedAtMs;
  }

  private nextStep(): string {
    this.stepSeq += 1;
    return `step_${this.stepSeq}`;
  }

  private ctx(stepId?: string): Ctx {
    return { agentId: this.agentId, runId: this.runId, stepId: stepId ?? this.nextStep() };
  }

  async llmCall(input: LlmCallInput): Promise<void> {
    this.llmCalls += 1;
    this.totalCostUsd += input.costUsd ?? 0;
    this.totalTokens += nonNegInt(input.inputTokens) + nonNegInt(input.outputTokens);
    this.client._emitLlmCall(input, this.ctx(input.stepId));
  }

  async toolCall(input: ToolCallInput): Promise<void> {
    this.toolCalls += 1;
    this.client._emitToolCall(input, this.ctx(input.stepId));
  }

  async outcome(input: OutcomeInput): Promise<void> {
    this.client._emitOutcome(input, { agentId: this.agentId, runId: this.runId });
  }

  async risk(input: RiskInput): Promise<void> {
    this.client._emitRisk(input, { agentId: this.agentId, runId: this.runId });
  }

  async trackAction(input: TrackActionInput): Promise<void> {
    this.client._emitAction(input, this.ctx(input.stepId));
  }
}

/** The LedgerAI client. Create once per process; reuse across requests. */
export class LedgerAI {
  private readonly apiKey?: string;
  private readonly eventsUrl: string;
  private readonly failOpen: boolean;
  private readonly tenantId?: string;
  private readonly appId?: string;
  private readonly userId?: string;
  private readonly environment?: string;
  private readonly maxBatch: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly contentCapture: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (message: string, detail?: unknown) => void;

  private buffer: LedgerEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(opts: LedgerAIOptions = {}) {
    this.apiKey = opts.apiKey ?? env('BADGERIQ_KEY') ?? env('BADGERIQ_API_KEY');
    const base = (opts.baseUrl ?? env('BADGERIQ_URL') ?? env('BADGERIQ_COLLECTOR_URL') ?? 'http://localhost:8090').replace(/\/+$/, '');
    this.eventsUrl = base.endsWith('/v1/events') ? base : `${base}/v1/events`;
    this.failOpen = opts.failOpen ?? true;
    this.tenantId = opts.tenantId ?? env('BADGERIQ_TENANT_ID');
    this.appId = opts.appId;
    this.userId = opts.userId;
    this.environment = opts.environment ?? 'prod';
    this.maxBatch = opts.maxBatch ?? 100;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
    this.contentCapture = opts.contentCapture ?? false;
    const f = opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) {
      throw new Error('LedgerAI: no fetch available — pass options.fetch on this runtime');
    }
    this.fetchImpl = f;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? ((m, d) => console.warn(`[ledgerai] ${m}`, d ?? ''));

    const interval = opts.flushIntervalMs ?? 2000;
    this.timer = setInterval(() => void this.autoFlush(), interval);
    // Don't keep a Node process alive just for the flush timer.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Run `fn` within an agent run, emitting a closing agent_run record either way.
   * On a thrown error the run is marked failed (and the record still emitted) and
   * the error is re-thrown — telemetry failures never mask your error.
   */
  async run<T>(opts: RunOptions, fn: (run: Run) => T | Promise<T>): Promise<T> {
    const run = new Run(this, opts.agentId, opts.runId, opts.metadata, this.now());
    try {
      const result = await fn(run);
      run.status = 'completed';
      return result;
    } catch (err) {
      run.status = 'failed';
      throw err;
    } finally {
      this.emitRunClose(run);
    }
  }

  // ---- public single-event methods (run-less; pass agentId/runId as needed) ----
  trackAction(input: TrackActionInput): void {
    this._emitAction(input, { agentId: input.agentId, runId: input.runId, stepId: input.stepId });
  }
  llmCall(input: LlmCallInput): void {
    this._emitLlmCall(input, { agentId: input.agentId, runId: input.runId, stepId: input.stepId });
  }
  toolCall(input: ToolCallInput): void {
    this._emitToolCall(input, { agentId: input.agentId, runId: input.runId, stepId: input.stepId });
  }
  outcome(input: OutcomeInput): void {
    this._emitOutcome(input, { agentId: input.agentId, runId: input.runId });
  }
  risk(input: RiskInput): void {
    this._emitRisk(input, { agentId: input.agentId, runId: input.runId });
  }

  // ---- event builders (shared by LedgerAI and Run) ----
  /** @internal */
  _emitLlmCall(c: LlmCallInput, ctx: Ctx): void {
    // Strict llm_call schema: only canonical, gen_ai-aligned fields — no content.
    this.enqueue({
      kind: 'llm_call',
      call_id: genId('call'),
      ts: this.iso(),
      tenant_id: this.tenantId,
      app_id: this.appId,
      user_id: this.userId,
      environment: this.environment,
      agent_id: ctx.agentId,
      run_id: ctx.runId,
      step_id: ctx.stepId,
      provider: c.provider,
      request_model: c.model,
      operation_name: c.operationName ?? 'chat',
      input_tokens: nonNegInt(c.inputTokens),
      output_tokens: nonNegInt(c.outputTokens),
      cache_read_tokens: nonNegInt(c.cacheReadTokens),
      cost_usd: Math.max(0, c.costUsd ?? 0),
      latency_ms: nonNegInt(c.latencyMs),
      status: c.status ?? 'ok',
      source: 'sdk',
    });
  }
  /** @internal */
  _emitToolCall(c: ToolCallInput, ctx: Ctx): void {
    this.enqueue({
      kind: 'tool_call',
      tool_call_id: genId('tool'),
      ts: this.iso(),
      tenant_id: this.tenantId,
      agent_id: ctx.agentId,
      run_id: ctx.runId,
      step_id: ctx.stepId,
      operation_name: 'execute_tool',
      tool_name: c.tool,
      mcp_server: c.mcpServer ?? '',
      status: c.status ?? 'ok',
      latency_ms: nonNegInt(c.latencyMs),
      source: 'sdk',
    });
  }
  /** @internal */
  _emitOutcome(c: OutcomeInput, ctx: Ctx): void {
    this.enqueue({
      kind: 'outcome',
      outcome_id: genId('out'),
      ts: this.iso(),
      tenant_id: this.tenantId,
      user_id: this.userId,
      agent_id: ctx.agentId,
      run_id: ctx.runId,
      source_system: c.sourceSystem,
      outcome_type: c.type,
      ref: c.ref ?? '',
      business_value_usd: c.valueUsd ?? 0,
      quality_score: c.qualityScore ?? 0,
      attribution_confidence: c.attributionConfidence ?? 1,
      completion_status: 'completed',
    });
  }
  /** @internal */
  _emitRisk(c: RiskInput, ctx: Ctx): void {
    this.enqueue({
      kind: 'risk',
      event_id: genId('risk'),
      ts: this.iso(),
      tenant_id: this.tenantId,
      agent_id: ctx.agentId,
      run_id: ctx.runId,
      category: c.category,
      severity: c.severity,
      detail: c.detail ?? '',
      occurrences: nonNegInt(c.occurrences ?? 1),
      source: 'sdk',
    });
  }
  /** @internal — a generic action is recorded as a tool_call. */
  _emitAction(c: TrackActionInput, ctx: Ctx): void {
    this.enqueue({
      kind: 'tool_call',
      tool_call_id: genId('tool'),
      ts: this.iso(),
      tenant_id: this.tenantId,
      agent_id: ctx.agentId,
      run_id: ctx.runId,
      step_id: ctx.stepId,
      operation_name: 'execute_tool',
      tool_name: c.action,
      status: 'ok',
      source: 'sdk',
      ...(c.attributes ?? {}),
    });
  }

  private emitRunClose(run: Run): void {
    this.enqueue({
      kind: 'agent_run',
      run_id: run.runId,
      ts: this.iso(),
      tenant_id: this.tenantId,
      app_id: this.appId,
      user_id: this.userId,
      agent_id: run.agentId,
      started_at: new Date(run.startedAtMs).toISOString(),
      ended_at: this.iso(),
      status: run.status,
      llm_calls: run.llmCalls,
      tool_calls: run.toolCalls,
      total_cost_usd: Math.round(run.totalCostUsd * 1e6) / 1e6,
      total_tokens: run.totalTokens,
      ...(run.metadata ?? {}),
    });
  }

  /** Await all buffered events to be sent. In fail-closed mode, throws on failure. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await this.send(batch);
    } catch (err) {
      this.log(`flush failed: dropped ${batch.length} event(s)`, err);
      if (!this.failOpen) throw err;
    }
  }

  /** Stop the flush timer and flush remaining events. In fail-closed mode, throws. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  // ---- internals ----
  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private enqueue(ev: LedgerEvent): void {
    if (this.closed) {
      this.log('event emitted after shutdown — dropped');
      return;
    }
    this.buffer.push(this.contentCapture ? ev : stripContent(ev));
    if (this.buffer.length >= this.maxBatch) {
      void this.autoFlush();
    }
  }

  // Background flush: never throws into the caller (even in fail-closed mode it
  // only logs, since there is no caller to receive the error).
  private async autoFlush(): Promise<void> {
    try {
      await this.flush();
    } catch (err) {
      this.log('background flush failed', err);
    }
  }

  private async send(batch: LedgerEvent[]): Promise<void> {
    const body = batch.map((e) => JSON.stringify(e)).join('\n');
    const headers: Record<string, string> = { 'Content-Type': 'application/x-ndjson' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await delay(Math.min(250, 50 * attempt));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.eventsUrl, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        if (res.ok) return; // 202 Accepted (or any 2xx)
        if (res.status >= 500 && attempt < this.maxRetries) {
          lastErr = new Error(`ledgerai sink HTTP ${res.status}`);
          continue; // retry server errors
        }
        throw new Error(`ledgerai sink HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
        if (attempt >= this.maxRetries) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

function stripContent(ev: LedgerEvent): LedgerEvent {
  let copy: LedgerEvent | undefined;
  for (const k of CONTENT_KEYS) {
    if (k in ev) {
      if (!copy) copy = { ...ev };
      delete copy[k];
    }
  }
  return copy ?? ev;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });
}
