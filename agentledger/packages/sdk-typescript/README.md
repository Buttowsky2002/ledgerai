# @badgeriq/sdk-typescript

Dependency-free TypeScript SDK for **BadgerIQ** — trace AI agents (runs, LLM
calls, tool calls, business outcomes, risk signals) to the BadgerIQ collector.
Zero runtime dependencies, browser-safe types, Node/server by default.

> The package is `@badgeriq/sdk-typescript`; the public class is still named
> `LedgerAI` (unchanged for API compatibility). See the repo "Renaming to
> BadgerIQ" note.

## Install

```jsonc
// package.json
"dependencies": { "@badgeriq/sdk-typescript": "file:../../packages/sdk-typescript" }
```

Node ≥ 20 (uses global `fetch`, `crypto`, `AbortController`); zero runtime deps.

## Quickstart

```ts
import { LedgerAI } from '@badgeriq/sdk-typescript';

const ledger = new LedgerAI({
  apiKey: process.env.BADGERIQ_KEY,
  baseUrl: process.env.BADGERIQ_URL, // e.g. http://localhost:8090
  tenantId: process.env.BADGERIQ_TENANT_ID,
  failOpen: true, // telemetry never throws into your app (default)
});

await ledger.run({ agentId: 'support-bot', metadata: { release: '2026.6' } }, async (run) => {
  await run.llmCall({ provider: 'openai', model: 'gpt-4o', inputTokens: 320, outputTokens: 140, costUsd: 0.0021 });
  await run.toolCall({ tool: 'search_kb' });
  await run.outcome({ type: 'ticket_resolved', sourceSystem: 'zendesk', valueUsd: 18.5, attributionConfidence: 0.9 });
});

await ledger.shutdown(); // flush before exit (scripts / serverless)
```

`run()` opens an agent run, gives you a `Run` to record activity, and always
emits the closing `agent_run` record (marked `failed` if your callback throws —
your error still propagates).

## Methods

| Method | Where | What |
|--------|-------|------|
| `run(opts, fn)` | client | Scope an agent run; emits the `agent_run` record. |
| `trackAction({ action, attributes? })` | client / run | Record a custom agent step/action. |
| `llmCall({ provider, model, inputTokens, outputTokens, costUsd, … })` | client / run | Record an LLM call (token/cost/latency). |
| `toolCall({ tool, mcpServer?, status?, latencyMs? })` | client / run | Record a tool / MCP invocation. |
| `outcome({ type, sourceSystem, valueUsd?, attributionConfidence?, ref? })` | client / run | Record a business outcome (drives ROI). |
| `risk({ category, severity, detail? })` | client / run | Record a risk signal. |
| `flush()` | client | Await all buffered events. Throws on failure in fail-closed mode. |
| `shutdown()` | client | Stop the flush timer and flush remaining events. |

Telemetry is **batched** and flushed every `flushIntervalMs` (default 2 s) or when
`maxBatch` (default 100) events are buffered. Sends use bounded retries + a
per-request timeout.

### fail-open vs fail-closed

`failOpen: true` (default) — transport errors are logged and dropped; your app
never sees them. `failOpen: false` — `flush()` / `shutdown()` **throw** on send
failure (for billing/audit-critical pipelines).

## Privacy — no raw content by default

The SDK never sends raw prompt/response content. The canonical event schema has
no content field, and the SDK strips known content keys
(`content`/`prompt`/`completion`/`messages`/…) from every event before sending.

> ⚠️ `contentCapture: true` is an explicit opt-in that lets content fields through.
> The standard BadgerIQ collector rejects raw content (privacy by design), so this
> is only meaningful if you operate your own capture pipeline. **Do not enable it
> unless you fully understand the data-handling implications.**

## OpenTelemetry compatibility

Event field names track the OpenTelemetry GenAI conventions
(`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, …).
`otelLlmAttributes(input)` returns the `gen_ai.*` attribute map if you also emit
OTel spans.

## Examples

Runnable, type-checked examples are in [`examples/`](./examples):

- [`quickstart.ts`](./examples/quickstart.ts)
- [Next.js route handler](./examples/nextjs-route.ts) — flush before the response on serverless.
- [Vercel AI SDK](./examples/vercel-ai.ts) — wrap `generateText`.
- [OpenAI SDK wrapper](./examples/openai-wrapper.ts) — instrument `chat.completions.create`.
- [Outcome](./examples/outcome.ts) — attribute a business result to a run.

### Next.js (App Router)

```ts
const ledger = new LedgerAI({ apiKey: process.env.BADGERIQ_KEY, baseUrl: process.env.BADGERIQ_URL });

export async function POST(req: Request): Promise<Response> {
  const answer = await ledger.run({ agentId: 'support-bot' }, async (run) => {
    await run.llmCall({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 200, outputTokens: 90, costUsd: 0.0005 });
    return '…';
  });
  await ledger.flush(); // serverless: flush before returning
  return Response.json({ answer });
}
```

### OpenAI SDK wrapper

```ts
const res = await openai.chat.completions.create({ model, messages });
await run.llmCall({
  provider: 'openai',
  model,
  inputTokens: res.usage?.prompt_tokens,
  outputTokens: res.usage?.completion_tokens,
});
```

## Scripts

- `npm run build` — emit `dist/` (CommonJS + `.d.ts`)
- `npm test` — jest unit tests (mock `fetch`)
- `npm run typecheck:examples` — type-check `examples/`
- `npm run lint` — eslint
