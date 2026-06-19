# @agentledger/sdk-typescript

Dependency-free TypeScript SDK for AgentLedger — the TS mirror of the Python SDK
(`packages/sdk-python`). It traces agent runs and emits the same events to the
collector (`POST /v1/events`), so TS agents land identical rows in ClickHouse:
`llm_call`, `tool_call`, `outcome`, and a closing `agent_run`.

Node ≥ 20 (uses the global `fetch` and `node:crypto`); zero runtime dependencies.

## Install

```jsonc
// package.json
"dependencies": { "@agentledger/sdk-typescript": "file:../../packages/sdk-typescript" }
```

## Usage

```ts
import * as al from '@agentledger/sdk-typescript';

al.init({
  collectorUrl: 'http://localhost:8090/v1/events',
  tenantId: 't1',
  appId: 'support-copilot',
  // userId, environment ('prod'), apiKey optional;
  // apiKey falls back to $AGENTLEDGER_API_KEY
});

// Context-manager style (always emits the closing agent_run; marks failed on throw):
await al.withRun('ticket-triage', 'triage #4812', async (run) => {
  // 1) Gateway path — let the gateway record cost; just propagate run identity:
  const headers = run.llmHeaders(); // pass to your OpenAI/Anthropic client

  // 2) Direct-call path — report usage yourself so cost attribution works:
  run.recordLlmCall({ provider: 'openai', model: 'gpt-4o', inputTokens: 150, outputTokens: 50, costUsd: 0.0012 });
  run.recordToolCall({ toolName: 'fetch_ticket', latencyMs: 120 });

  run.recordOutcome({
    outcomeType: 'ticket_resolved',
    sourceSystem: 'zendesk',
    ref: '4812',
    businessValueUsd: 18.5,
    attributionConfidence: 0.9,
  });
});
```

Explicit lifecycle (when a run spans functions):

```ts
const run = al.startRun('ticket-triage', 'triage #4812');
try {
  run.recordLlmCall({ provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 5 });
} finally {
  run.end(); // emits the agent_run record
}
```

## Flushing (important for short-lived processes)

Telemetry is **fire-and-forget** and never throws into your app. Because a Node
process can exit before an un-awaited POST completes, call `await al.flush()`
before exit in scripts, serverless handlers, and tests:

```ts
await al.flush(); // awaits all in-flight event posts
```

(The Python SDK relies on daemon threads; Node has no equivalent, so `flush()` is
provided explicitly.)

## Scripts

- `npm run build` — emit `dist/` (CommonJS + `.d.ts`)
- `npm run lint` — eslint
- `npm test` — jest unit tests (mock `fetch`)
