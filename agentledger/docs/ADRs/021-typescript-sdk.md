# ADR-021 — TypeScript SDK

**Date:** 2026-06-18
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 4 (CLAUDE_CODE_BUILD_SPEC.md §3); ADR-005 (ingest collector); `packages/sdk-python`

---

## Context

The Python SDK lets app code instrument agent runs and fire telemetry —
`llm_call` / `tool_call` / `outcome` / closing `agent_run` events — to the collector's
`POST /v1/events`. Node/TypeScript agents had no equivalent. Phase 4 task 6 adds
`packages/sdk-typescript`, a faithful mirror so TS agents land the same rows in ClickHouse.

## Decision

### Faithful parity with the Python SDK

Same event `kind`s and **identical wire payloads** (snake_case field names, `source: "sdk"`,
`gen_ai.*`-aligned keys), the same prefixed-hex IDs (`run_`/`call_`/`out_`/`step_`, 16 hex), the
same second-precision `…Z` timestamps, and the same `llmHeaders()` for gateway run-identity
propagation. Only the *TypeScript argument* names are camelCase (options objects); the JSON on the
wire matches Python exactly, so the collector/schema contract (ADR-005,
`schemas/events/llm_call.schema.json`) is unchanged.

### Run lifecycle: `startRun` + `withRun`

TS has no `with` context manager, so the SDK exposes `startRun(agentId, objective)` returning a
`Run` with an explicit `end()` (emits `agent_run`), **plus** `withRun(agentId, objective, fn)` that
try/finally-closes and marks the run `failed` on throw — the idiomatic stand-in for Python's
`with al.run(...)`.

### CommonJS, zero runtime dependencies

Built as CommonJS (tsconfig like `services/api`) for clean `jest` + `ts-jest` unit tests (the repo's
proven setup) and `require()`/`import` compatibility. No runtime deps — Node 20's global `fetch`
and `node:crypto` only (rule 3). Lint/test/format devDeps mirror the existing packages.

### Fire-and-forget transport + explicit `flush()`

`post()` issues an un-awaited `fetch` (5s `AbortSignal.timeout`) and swallows all errors, so
telemetry never breaks the host — mirroring Python's daemon-thread post. Python relies on daemon
threads surviving until sent; Node has no equivalent and an exiting process drops un-awaited
requests, so the SDK tracks in-flight posts and adds **`flush()`** (await all pending) for scripts,
serverless handlers, and tests. This is the one deliberate addition over Python parity.

## Consequences

- **Positive**: TS agents get the same instrumentation as Python with no dependencies; the wire
  contract and downstream pipeline are untouched. Unit-tested by mocking global `fetch`.
- **Negative / scope**: CommonJS-only output (no ESM/dual build) — fine for a Node telemetry SDK;
  revisit if browser/ESM-only consumers appear. `agent_run`/`tool_call`/`outcome` remain
  envelope-validated at the collector (only `llm_call` has a formal JSON Schema today), same as the
  Python SDK.
- **Operational**: wired into the Makefile (`build`/`test`/`lint`/`api-install` include the new
  package) so CI covers it; on the Windows dev host run the npm scripts directly. `flush()` should
  be called before exit in short-lived processes or events may be dropped.
