# ADR-004 — Anthropic-Native `/v1/messages` Translation

**Date:** 2026-06-16
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 1, task 4 (CLAUDE_CODE_BUILD_SPEC.md §3); ARCHITECTURE.md §9

---

## Context

Clients built on the Anthropic SDK speak the **Messages API** (`POST /v1/messages`),
which differs from the OpenAI Chat Completions shape the gateway proxies today:
a top-level `system` prompt, `content` as either a string or an array of typed
blocks, `max_tokens` required, and a response of `content` blocks with
`stop_reason` and an Anthropic-shaped `usage` object (`input_tokens`,
`output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`).

The Phase 1 task is "Anthropic-native translation: `/v1/messages` endpoint
translating Messages API ↔ internal canonical request, including streaming and
cache-token accounting." ARCHITECTURE.md §9 pins the meaning precisely:
**"Anthropic-native API translation (Messages API ↔ OpenAI format)."**

So the requirement is an *edge translation*, not a second proxy stack: Anthropic
clients must get full gateway governance (auth, allowlist, budget, DLP, cost,
attribution) with zero new inline-path logic.

---

## Decision

### The OpenAI Chat Completions shape is the internal canonical request

`/v1/messages` translates the incoming Anthropic request into a canonical OpenAI
body, then runs the **exact same inline path** as `/v1/chat/completions`. The
nine-stage path (`proxy.go`) was refactored into a shared `serveCanonical`
method that both endpoints call; the only per-endpoint differences are (a) request
parsing and (b) response rendering, captured by a `respFormat` flag. No
policy, budget, DLP, pricing, or attribution code is duplicated or branched.

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| Native Anthropic proxy stack (POST upstream `/v1/messages`, parse Anthropic SSE) | Duplicates the entire inline path with provider-specific response handling; contradicts ARCHITECTURE §9's "↔ OpenAI format"; the existing `claude-` routing already targets Anthropic's OpenAI-compatible `/v1/chat/completions` |
| Translate only the request, pass the OpenAI response through unchanged | Anthropic SDK clients can't parse an OpenAI response body; breaks the contract |
| A standalone translation microservice | Adds a network hop on the hot path; violates the "inline path performs zero I/O" rule |

### Request translation (Messages → canonical)

`translateMessagesToCanonical`: the top-level `system` becomes a leading
`{"role":"system"}` message; each message's `content` is flattened to text
(`anthropicTextFromRaw` handles both the string and content-block-array forms);
`stop_sequences`→`stop`, `max_tokens`/`temperature`/`top_p`/`stream` pass through.
The canonical body is then unmarshalled into the existing `chatRequest`, so DLP
text extraction and redaction (`extractText`, `redactBody`) work unchanged.

### Response translation (canonical → Messages)

- **Buffered**: `choices[0].message.content` → a single `text` content block;
  `finish_reason` → `stop_reason` via `mapStopReason`
  (`stop`→`end_turn`, `length`→`max_tokens`, `tool_calls`→`tool_use`).
- **Streaming**: `translateStreamOpenAIToAnthropic` consumes OpenAI SSE chunks
  and emits the full Anthropic event sequence — `message_start` →
  `content_block_start` → `content_block_delta`\* → `content_block_stop` →
  `message_delta` → `message_stop` — flushing per event so streaming latency is
  preserved.

### Cache-token accounting

The gateway already captures `cache_read`/`cache_write` tokens via `parseUsage`
(it reads both OpenAI `prompt_tokens_details.cached_tokens` and Anthropic-style
`cache_*_input_tokens`). `anthropicUsageMap` renders these back in Anthropic
terms, subtracting cache reads from `input_tokens` to match Anthropic's
semantics (where `input_tokens` excludes cached input). Cost is computed by the
same effective-dated price book, so cache reads are billed at the cache-read rate.

**Streaming usage ordering note**: OpenAI streams usage only in the final chunk,
whereas Anthropic puts `input_tokens` in the *first* event (`message_start`). We
therefore emit `message_start` with `input_tokens: 0` and the authoritative full
usage in the closing `message_delta`. The gateway's own cost accounting always
uses the captured final usage, so **billing is exact** regardless of the
client-facing streaming placement.

### Error responses

Errors on the `/v1/messages` path are rendered in the Anthropic error envelope
(`{"type":"error","error":{"type":...,"message":...}}`) via `writeAnthropicErr`,
with HTTP status mapped to Anthropic error types (`authentication_error`,
`permission_error`, `rate_limit_error`, …). The OpenAI path is unchanged.

---

## Consequences

- **Positive**: Anthropic SDK clients point `base_url` at the gateway and get
  full governance with no client changes; works for any model the gateway routes
  (the canonical body goes to the model's OpenAI-compatible upstream).
- **Positive**: One shared inline path — `serveCanonical` — so policy/budget/DLP
  behavior is provably identical across both endpoints (the OpenAI test suite
  exercises the same core).
- **Negative / scope**: Non-text content blocks (images, `tool_use`/`tool_result`)
  are flattened to their text parts; full multimodal and tool-call round-tripping
  is deferred. Documented in `messages.go`.
- **Negative**: Streaming `input_tokens` appears in `message_delta` rather than
  `message_start`; clients that read input usage exclusively from `message_start`
  will see 0. Internal accounting is unaffected.
- **Future**: When a native Anthropic upstream (non-OpenAI-compat) is required,
  `dispatchUpstream` is the single seam to add an Anthropic-native request/SSE
  path behind the same `serveCanonical` core.
