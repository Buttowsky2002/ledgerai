# ADR-050 — Self-hosted, provider-agnostic inference for risk-enrichment

**Date:** 2026-07-05
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** ADR-030 (semantic risk-enrichment worker — supersedes its *provider* choice, not its design); ADR-027 (deterministic risk tier); ADR-051 (BadgerAI fine-tune pipeline)

---

## Context

ADR-030 shipped the semantic risk-enrichment tier: the worker reads per-run
tool/MCP call **sequences** (metadata only — CLAUDE.md rule 2) from
`agent_tool_calls` and asks an LLM to classify behavioral risk the deterministic
tier can't express. That worker called the **Anthropic Messages API** — an
external AI API.

BadgerIQ must run on our **own** model. Depending on a third-party inference API
for a core product signal is a data-egress surface (even metadata leaves our
perimeter), a cost and availability dependency, and off-strategy for a control
plane that sells governance. This ADR removes that dependency for
risk-enrichment; ADR-051 covers making the model genuinely ours (a purpose
fine-tune).

## Decision

### Provider-agnostic client over an OpenAI-compatible endpoint

`internal/riskenrich/llm_client.go` adds `OpenAICompatibleClient`, which POSTs to
`{BADGERIQ_LLM_BASE_URL}/v1/chat/completions`. That one shape works unchanged
against **vLLM, Ollama, llama.cpp server, and TGI**, so operators choose their
own serving stack. It uses **stdlib `net/http` only** — no vendor SDK, no new Go
dependency (CLAUDE.md rule 12). The `AnthropicClassifier` and all Anthropic
request/response types are deleted; `github.com/badgeriq/workers` gains **zero**
new modules.

Structured output is requested two ways for portability: OpenAI-style
`response_format: {type: "json_schema", …}` **and** vLLM's `guided_json`, sent
only when a schema is present. A server that ignores both still works because the
classifier re-extracts and re-validates the JSON itself.

### Guardrails hardened for a smaller model, not relaxed

A self-hosted ~8B model is weaker than a frontier API, so the guardrails matter
*more*. `LLMClassifier` preserves and strengthens them, in order:
1. **Metadata-only prompt** — unchanged; only the tool sequence, MCP servers, and
   call count are ever sent. No prompt/completion content exists to leak.
2. **JSON-schema-constrained request** (`assessmentSchema()`).
3. **Tolerant JSON extraction** — balanced-brace scan strips code fences / prose.
4. **Post-parse validation** — findings with a category outside the fixed enum or
   a confidence outside `[0,1]` are **dropped**; unknown severities normalize to
   `low`. A hallucinated category can never reach `risk_events`.
5. **Retry-then-deterministic-fallback** — a 200 whose content will not
   parse/validate is retried once, then falls back to an **empty** assessment.
   The deterministic tier (ADR-027) stays authoritative; a bad generation
   produces *no* finding rather than a fabricated one.

Transport/5xx/timeout errors are retried twice with exponential backoff inside
the client and, if still failing, surfaced to the engine (logged + counted) so an
outage is visible rather than silently swallowed.

### No secrets, no body logging, no egress

`BADGERIQ_LLM_API_KEY` is **optional** — only for an authenticated gateway placed
in front of the model — and is an env-var name (rule 1), never logged. The client
records aggregate metrics only (request/retry/failure/malformed/fallback counts,
cumulative latency, token counts when the server reports them) and **never logs a
request or response body** (rule 2). Errors carry a status code and attempt
context only — never a body — so the engine can log them safely. At inference
time the worker talks only to the operator-provided model endpoint; nothing
egresses to a third-party AI API.

### Config

`BADGERIQ_LLM_BASE_URL` (default `http://localhost:8000`; `http://badger-llm:8000`
in compose), `BADGERIQ_LLM_MODEL` (default `badger-ai-8b`), `BADGERIQ_LLM_API_KEY`
(optional), `BADGERIQ_LLM_TIMEOUT_S` (60), `BADGERIQ_AI_MAX_TOKENS` (2000). The
worker still gates on `BADGERIQ_RISK_ENRICH_ENABLED=true`; the old
`ANTHROPIC_API_KEY` gate and `BADGERIQ_RISK_ENRICH_MODEL` / `BADGERIQ_ANTHROPIC_BASE_URL`
are removed. `ANTHROPIC_API_KEY` remains a *gateway* provider key (for customer
traffic the gateway proxies) and is untouched.

### Scope — what is NOT changed

"No external AI API" is scoped to **inference we originate**. Deliberately left in
place: the gateway's Anthropic `/v1/messages` translation (it proxies the
*customer's* traffic — removing it would break the product) and the
`anthropic-usage` billing connector / portal import (they ingest *billing
records*, not model calls). Those are data sources, not AI calls we make.

## Consequences

- Risk-enrichment runs entirely on self-hosted inference; no third-party AI API,
  no per-call vendor cost, no metadata egress.
- No new Go dependency; no migration; the `Classifier`/`Engine` seam and every
  existing engine test are unchanged.
- Tests: `llm_client_test.go` (happy path, retry-on-500, timeout, structured-output
  request shape, no-body-in-error) and `classifier_test.go` (valid accept,
  malformed→retry→fallback, invalid-category/out-of-range dropped, bad-severity
  normalized, transport error surfaced, fenced-JSON extraction), plus an engine
  per-tenant stamping isolation test.
- The default model `badger-ai-8b` is produced by the pipeline in ADR-051; until a
  trained artifact exists, any OpenAI-compatible model can be pointed at for dev.
- **Operational note:** the model server is deployed out-of-chart (a GPU workload /
  managed vLLM), like the stateful infra; the Helm chart only points the worker at
  `BADGERIQ_LLM_BASE_URL`.
