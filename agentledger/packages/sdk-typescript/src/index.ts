/**
 * AgentLedger TypeScript SDK (MVP).
 *
 * Dependency-free tracing for agents and workflows — a faithful TS mirror of the
 * Python SDK (`packages/sdk-python`). Emits the same events (gen_ai.*-aligned)
 * to the collector's `POST /v1/events`, so the same rows land in ClickHouse:
 *   - `llm_call`   — one per direct provider call (when not routed through the gateway)
 *   - `tool_call`  — one per tool/function invocation
 *   - `outcome`    — a business outcome (the ROI differentiator)
 *   - `agent_run`  — the closing run record (unit-economics denominator), on end()
 *
 * Two integration paths:
 *
 *  1. Route LLM traffic through the AgentLedger gateway and use this SDK only for
 *     run/step/outcome context — `run.llmHeaders()` propagates run identity:
 *
 *       import * as al from '@agentledger/sdk-typescript';
 *       al.init({ collectorUrl: 'http://localhost:8090/v1/events', tenantId: 't1', appId: 'support-copilot' });
 *       await al.withRun('ticket-triage', 'triage #4812', async (run) => {
 *         const headers = run.llmHeaders();           // pass to your OpenAI client
 *         // ... gateway records cost per call ...
 *         run.recordOutcome({ outcomeType: 'ticket_resolved', sourceSystem: 'zendesk',
 *                             ref: '4812', businessValueUsd: 18.5, attributionConfidence: 0.9 });
 *       });
 *
 *  2. No gateway (direct provider calls): also report usage with
 *     `run.recordLlmCall(...)` so cost attribution still works.
 *
 * Telemetry is fire-and-forget and never throws into the host app. Because a Node
 * process can exit before an un-awaited POST flushes, call `await al.flush()`
 * before exit in short-lived contexts (scripts, serverless, tests).
 */

import { randomBytes } from 'node:crypto';

interface Config {
  collectorUrl: string;
  tenantId: string;
  appId: string;
  userId: string;
  environment: string;
  apiKey: string;
}

let config: Config | null = null;

const pending = new Set<Promise<void>>();

export interface InitOptions {
  collectorUrl: string;
  tenantId: string;
  appId: string;
  userId?: string;
  environment?: string;
  apiKey?: string;
}

/** Configure the SDK once per process. */
export function init(opts: InitOptions): void {
  config = {
    collectorUrl: opts.collectorUrl,
    tenantId: opts.tenantId,
    appId: opts.appId,
    userId: opts.userId || process.env.USER || process.env.USERNAME || '',
    environment: opts.environment || 'prod',
    apiKey: opts.apiKey || process.env.AGENTLEDGER_API_KEY || '',
  };
}

function requireConfig(): Config {
  if (!config) {
    throw new Error('AgentLedger SDK not initialized: call init(...) before startRun(...)');
  }
  return config;
}

/** Fire-and-forget event post; never raises into the host app. */
function post(payload: Record<string, unknown>): void {
  if (!config) {
    return;
  }
  const p: Promise<void> = fetch(config.collectorUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  })
    .then(() => undefined)
    .catch(() => undefined) // telemetry must never break the workload
    .finally(() => {
      pending.delete(p);
    });
  pending.add(p);
}

/**
 * Await all in-flight event posts. Call before process exit in short-lived
 * contexts so fire-and-forget telemetry isn't dropped. (The Python SDK relies on
 * daemon threads; Node has no equivalent, hence this explicit flush.)
 */
export async function flush(): Promise<void> {
  await Promise.allSettled([...pending]);
}

function hexId(prefix: string): string {
  return prefix + randomBytes(8).toString('hex');
}

/** ISO-8601 UTC at second precision with a 'Z' suffix (matches the Python SDK). */
function iso(d: Date): string {
  return d.toISOString().slice(0, 19) + 'Z';
}

function isoNow(): string {
  return iso(new Date());
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface LlmCall {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  latencyMs?: number;
  cacheReadTokens?: number;
}

export interface ToolCall {
  toolName: string;
  status?: string;
  latencyMs?: number;
  /** MCP server id, if the tool is served over MCP. */
  mcpServer?: string;
}

export interface Outcome {
  outcomeType: string;
  sourceSystem: string;
  ref?: string;
  businessValueUsd?: number;
  qualityScore?: number;
  attributionConfidence?: number;
}

/** An agent run: the unit-economics denominator. */
export class Run {
  readonly agentId: string;
  objective: string;
  readonly runId: string;
  status = 'completed';
  private readonly startedAt: Date;
  private llmCalls = 0;
  private toolCalls = 0;
  private costUsd = 0;
  private tokens = 0;
  private stepSeq = 0;

  constructor(agentId: string, objective = '') {
    this.agentId = agentId;
    this.objective = objective;
    this.runId = hexId('run_');
    this.startedAt = new Date();
  }

  private nextStep(): string {
    this.stepSeq += 1;
    return `step_${this.stepSeq}`;
  }

  /** Headers that propagate run identity through the gateway. */
  llmHeaders(stepId = ''): Record<string, string> {
    return {
      'X-AgentLedger-Agent-Id': this.agentId,
      'X-AgentLedger-Run-Id': this.runId,
      'X-AgentLedger-Step-Id': stepId || this.nextStep(),
    };
  }

  /** Direct-call accounting (no gateway). */
  recordLlmCall(c: LlmCall): void {
    const cfg = requireConfig();
    this.llmCalls += 1;
    this.costUsd += c.costUsd ?? 0;
    this.tokens += c.inputTokens + c.outputTokens;
    post({
      kind: 'llm_call',
      call_id: hexId('call_'),
      ts: isoNow(),
      tenant_id: cfg.tenantId,
      app_id: cfg.appId,
      user_id: cfg.userId,
      environment: cfg.environment,
      agent_id: this.agentId,
      run_id: this.runId,
      step_id: this.nextStep(),
      provider: c.provider, // gen_ai.provider.name
      request_model: c.model, // gen_ai.request.model
      operation_name: 'chat', // gen_ai.operation.name
      input_tokens: c.inputTokens,
      output_tokens: c.outputTokens,
      cache_read_tokens: c.cacheReadTokens ?? 0,
      cost_usd: c.costUsd ?? 0,
      latency_ms: c.latencyMs ?? 0,
      status: 'ok',
      source: 'sdk',
    });
  }

  recordToolCall(c: ToolCall): void {
    const cfg = requireConfig();
    this.toolCalls += 1;
    post({
      kind: 'tool_call',
      // Stable, unique id — the agent_tool_calls dedup key (without it,
      // ClickHouse's ReplacingMergeTree collapses an agent's tool calls).
      tool_call_id: hexId('tool_'),
      ts: isoNow(),
      tenant_id: cfg.tenantId,
      run_id: this.runId,
      agent_id: this.agentId,
      step_id: this.nextStep(),
      operation_name: 'execute_tool', // gen_ai agent-span convention
      tool_name: c.toolName, // gen_ai.tool.name
      mcp_server: c.mcpServer ?? '', // MCP server id, if any
      status: c.status ?? 'ok',
      latency_ms: c.latencyMs ?? 0,
      source: 'sdk',
    });
  }

  /** The differentiator: business outcomes. Returns the generated outcome_id. */
  recordOutcome(o: Outcome): string {
    const cfg = requireConfig();
    const outcomeId = hexId('out_');
    post({
      kind: 'outcome',
      outcome_id: outcomeId,
      ts: isoNow(),
      tenant_id: cfg.tenantId,
      user_id: cfg.userId,
      run_id: this.runId,
      source_system: o.sourceSystem,
      outcome_type: o.outcomeType,
      ref: o.ref ?? '',
      business_value_usd: o.businessValueUsd ?? 0,
      quality_score: o.qualityScore ?? 0,
      attribution_confidence: o.attributionConfidence ?? 1,
      completion_status: 'completed',
    });
    return outcomeId;
  }

  fail(reason = ''): void {
    this.status = 'failed';
    if (reason) {
      this.objective = `${this.objective} [failed: ${reason}]`;
    }
  }

  /** Emit the closing agent_run record. Called automatically by withRun(). */
  end(): void {
    const cfg = requireConfig();
    post({
      kind: 'agent_run',
      run_id: this.runId,
      ts: isoNow(),
      tenant_id: cfg.tenantId,
      app_id: cfg.appId,
      user_id: cfg.userId,
      agent_id: this.agentId,
      objective: this.objective,
      started_at: iso(this.startedAt),
      ended_at: isoNow(),
      status: this.status,
      llm_calls: this.llmCalls,
      tool_calls: this.toolCalls,
      total_cost_usd: round6(this.costUsd),
      total_tokens: this.tokens,
    });
  }
}

/** Begin an agent run. Throws if init() has not been called. */
export function startRun(agentId: string, objective = ''): Run {
  requireConfig();
  return new Run(agentId, objective);
}

/**
 * Run `fn` within an agent run, always emitting the closing record — the TS
 * equivalent of Python's `with al.run(...)`. On a thrown error the run is marked
 * failed (then closed) and the error is re-thrown.
 */
export async function withRun<T>(
  agentId: string,
  objective: string,
  fn: (run: Run) => T | Promise<T>,
): Promise<T> {
  const run = startRun(agentId, objective);
  try {
    const result = await fn(run);
    run.end();
    return result;
  } catch (err) {
    run.fail(err instanceof Error ? err.name : 'Error');
    run.end();
    throw err;
  }
}
