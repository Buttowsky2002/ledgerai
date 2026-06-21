# ADR-032 — Inline tool/MCP governance in the gateway

**Date:** 2026-06-21
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 5 (CLAUDE.md — agent-native risk engine); ADR-027 (agent-native risk engine — last of its deferred follow-ups); ADR-029 (OTel tool-span ingestion); ADR-022 (additive-enum precedent)

---

## Context

The agent-native risk engine (ADR-027) defines a per-agent, deny-by-default
allowlist of the tools / MCP servers an agent may use (`agent_tool_allowlist` in
Postgres, mirrored to `agent_tool_allow` in ClickHouse). P5 shipped the control
plane (allowlist CRUD), the ClickHouse views, and the async risk-engine worker
that compares **observed** tool calls (`agent_tool_calls`) against the allowlist
and raises governed risk events.

That comparison was, until now, only ever made **after the fact**: a disallowed
tool call still ran, and was merely scored as risk on the next worker pass.
CLAUDE.md §3 (Phase 5) calls for the enforcement half — "deny-by-default
allowlists … enforcement in gateway when present." This is the last deferred
piece of ADR-027 (the others: OTel tool-span ingest = ADR-029, semantic tier =
ADR-030, NHI credentials = ADR-031).

The constraint that shapes the design: the gateway inline path must perform
**zero I/O** (CLAUDE.md ARCHITECTURE binding decision + rule 12) and the gateway
is the **optional** enforcement tier — most traffic never flows through it, and
deploying it must never break existing traffic (CLAUDE.md §1).

## Decision

Enforce the existing allowlist **inline** in the gateway, off the
atomically-swapped config snapshot, so a disallowed tool/MCP server is refused
**before** it is ever offered to the model.

### Where the data comes from — snapshot only, zero inline I/O

`PGConfigStore.Load` now also reads `agent_tool_allowlist` (alongside
`virtual_keys` and DLP policies) and folds it into `Config.AgentToolAllow`. The
hot-reload goroutine builds a `ToolGovernor` into each new snapshot (30 s
refresh, last-known-good on outage). The request path only consults the
in-memory governor — no database round-trip. The gateway already connects as a
`BYPASSRLS` role for its cross-tenant config reads, so no grant/RLS change is
needed; reading the allowlist is just another config read.

### Enforcement model — "observe everywhere, enforce where configured"

This is the one genuine design choice, and it is a deliberate asymmetry between
the async worker and the inline gateway:

- **Async worker — strict deny-by-default (unchanged).** Any observed tool call
  lacking an `allowed = 1` row is flagged, *even for agents nobody has
  configured*. Flagging unconfigured agents is correct: observation is free and
  surfaces shadow tool use.
- **Inline gateway — enforce only where an allowlist exists.** The gateway
  *blocks* only for an agent that has **at least one** allowlist entry — i.e. an
  operator has deliberately defined that agent's tool surface. Within that scope
  it is deny-by-default: any declared tool/MCP server not in the set is blocked.
  Agents with **no** entries — and requests carrying no `X-AgentLedger-Agent-Id`
  — are never blocked inline.

Why not strict deny-by-default inline too? Because blocking every tool-using
request from every not-yet-configured agent the moment the gateway is deployed
would violate "the gateway is optional, never break existing traffic." Populating
an allowlist *is* the opt-in to enforcement. An operator watches the worker's
risk signal first, then turns on blocking by defining the list — the standard
maturity path for allowlist governance. The asymmetry (observe broadly, enforce
narrowly) is the point, not an oversight.

### What is checked

The declared tool surface of the request, not a post-hoc observed call:

- OpenAI Chat Completions: `tools[].function.name`, `tools[].server_label`
  (MCP), and legacy `functions[].name`.
- Anthropic Messages: `tools[].name` and `mcp_servers[].name`, carried through
  `translateMessagesToCanonical` into the canonical OpenAI body so the shared
  inline path sees them.

Tool names and MCP server names share one matching namespace per agent (the
allowlist's `tool_name` and `mcp_server` columns both populate the allowed set).
A blocked request never reaches the upstream provider.

### Signal

A block sets `status = "blocked_tool"` and `risk_severity = "high"` on the
canonical `llm_call` event, and returns `403` (`tool_not_allowed`, naming the
offending tools) in the client's format (OpenAI or Anthropic). `blocked_tool` is
an **additive** status enum value (precedent: ADR-022's additive `source` enum):

- ClickHouse `llm_calls.status` is `LowCardinality(String)` — no migration.
- The `spend_daily` rollup already counts `status LIKE 'blocked%'`, so blocked
  tool calls are captured without query changes, and `agent_id` (already a
  column) lets the CISO view aggregate inline enforcement per agent.

No new event field is added — rule 2 (no raw content in the pipeline) and the
schema's `additionalProperties: false` posture are preserved. The specific
blocked tool name is in the 403 message and structured logs, not the analytics
row.

## Consequences

- **Positive:** the risk allowlist becomes preventive, not just detective, when
  the gateway is in the path. No schema migration, no API change, no new control
  plane — it reuses exactly what P5 (ADR-027) built. Inline cost is a couple of
  map lookups against the snapshot — well within the p95 < 75 ms policy budget.
- **Negative / accepted:** enforcement and the worker's risk model disagree by
  design for unconfigured agents (worker flags, gateway allows). Documented
  above. An operator who populates an allowlist intending only observation will
  begin blocking — this is the contract, and the gateway is the opt-in
  enforcement tier.
- **Follow-up:** blast-radius / per-tool blocked-call detail in the CISO view
  currently derives from `agent_tool_calls` (observed) + the worker; inline
  blocks short-circuit observation, so a future enhancement could emit a
  lightweight governance signal for blocked-inline calls if per-tool inline
  analytics are wanted. Not needed for the P5 acceptance criterion.
