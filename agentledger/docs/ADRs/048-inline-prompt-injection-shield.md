# ADR-048 — Inline prompt-injection shield in the gateway

**Date:** 2026-07-01
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 5/6 (CLAUDE.md — agent-native risk engine); ADR-032 (inline tool governance precedent); ADR-030 (semantic risk enrichment); ADR-022 (additive-enum precedent)

---

## Context

Prompt injection is the top operational risk for agentic systems: untrusted text
(user prompts, documents, and especially **MCP tool output** fed back on the next
turn) can hijack model behavior, exfiltrate data, or smuggle tool calls. The
gateway already ships deterministic DLP (`DLPEngine`) and inline tool/MCP
governance (`ToolGovernor`) off the atomically-swapped config snapshot — zero
inline I/O, sub-millisecond regex cost, well within the p95 < 75 ms policy
budget (ADR-032, CLAUDE.md rule 12).

The async `riskenrich` worker already classifies `injection_suspected` from tool-call
*sequences* (metadata only). What was missing is a **preventive inline tier** on
the request path for known patterns, plus a CISO surface that unions inline blocks
with semantic flags.

**Honest scope:** the gateway does **not** proxy MCP servers. MCP execution
happens client-side; results arrive in-projected in inbound requests (`role:"tool"`
messages / Anthropic `tool_result` blocks). Direction B scans that untrusted
content before it reaches the model on the next turn — it is not "MCP proxy
protection."

**Honest limits:** no detector catches all injection. The inline tier catches
*known patterns* at regex+rune cost; the async LLM tier catches *behavioral*
cases the regexes miss; residual risk remains. We state this plainly everywhere
(code, ADR, dashboard) — defense-in-depth with confidence scoring, never
"complete protection."

## Decision

Add a deterministic `InjectionEngine` to the gateway snapshot, mirroring
`DLPEngine`:

### Where the data comes from — snapshot only, zero inline I/O

`PGConfigStore.Load` reads `injection_policy` and `virtual_keys.injection_policy_id`
(alongside DLP policies and tool allowlists). The hot-reload goroutine builds an
`InjectionEngine` into each snapshot. The request path only consults in-memory
rules and policies — no database round-trip.

### What's checked

- **Direction A — prompt path:** user/system text already extracted for DLP
  (`extractText`).
- **Direction B — MCP tool responses in inbound requests:** `tool_result` /
  `role:"tool"` message content concatenated by `extractToolResultText`. Anthropic
  `tool_result` blocks are mapped into canonical `role:"tool"` messages by
  `translateMessagesToCanonical`.

Both paths share one engine; `InjectionFinding.Source` distinguishes them.

### Enforcement model — confidence-bounded default block

Default when no per-key policy row exists:

- **Block** any finding with `severity ∈ {high, critical}` AND
  `confidence ≥ BlockMinConfidence` (default **0.8**).
- **Flag** (`injection_action = flag`, event emitted) for all other hits.
- `encoded_payload_hint` **never blocks alone** (flag only).

A configured `InjectionPolicy` overrides the action for covered classes but not
the confidence gate for `block`. Redaction is available (`action = redact`) but
is not the default.

Master switch: `InjectionConfig.Enabled` (default true). `ScanToolResults`
(default true) gates Direction B.

### Signal

- Block sets `status = "blocked_injection"` (additive enum — precedent ADR-032
  `blocked_tool`, ADR-022 additive `source`). `llm_calls.status` is
  `LowCardinality(String)` — **no ClickHouse migration**. `spend_daily`'s
  `status LIKE 'blocked%'` already counts blocked injection calls.
- Event carries `injection_action` + `injection_findings` (metadata only — class,
  source, severity, confidence, count; **never raw content**, rule 2). Same
  persistence posture as DLP: categorical fields on the event; detailed semantic
  findings land in `risk_events` (`semantic_injection_suspected`).
- Returns `403` (`injection_blocked`, naming offender classes) in the client's
  format (OpenAI or Anthropic).

The async semantic tier (`riskenrich`) is unchanged in category enum; its system
prompt now explicitly reasons about tool_result-sourced injection patterns in
tool-call sequences.

### CISO surface

`GET /v1/analytics/injection` unions inline blocks (`llm_calls` where
`status = 'blocked_injection'`) with semantic flags (`risk_events` where
`category = 'semantic_injection_suspected'`) per agent. The dashboard CISO page
adds an "Injection posture" section with honest copy about defense-in-depth.

## Consequences

- **Positive:** known high-confidence injection patterns are refused before budget
  reservation and upstream dispatch; MCP-returned untrusted text is scanned on the
  next turn; reuses P5/P6 infra (snapshot reload, `risk_events`, CISO view); inline
  cost is regex + Unicode Tags rune scan (same class as DLP).
- **Negative / accepted:** novel phrasings, heavy obfuscation, and purely semantic
  attacks pass the inline tier — the async worker partially covers behavioral
  cases; residual risk remains by design. Operators who set `action = block` on a
  policy should expect false positives on edge phrasing; the confidence gate and
  conservative regexes mitigate but do not eliminate that tradeoff.
- **Follow-up:** per-class tuning from production false-positive rates; optional
  tenant-level `Enabled = false` for audit-only rollout. No new control-plane CRUD
  beyond the additive `injection_policy` table this migration introduces.
