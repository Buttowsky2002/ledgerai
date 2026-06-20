# ADR-029 — OTel tool-span ingestion

**Date:** 2026-06-20
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 6 (CLAUDE.md — enterprise hardening); ADR-022 (OTel GenAI ingestion); ADR-027 (agent-native risk engine — this is the first of its deferred follow-ups)

---

## Context

The agent-native risk engine (ADR-027) compares observed tool/MCP calls
(`agent_tool_calls`) against a deny-by-default allowlist and raises governed risk
events. P5 shipped the table, the views, the worker, and the control plane — but
**`agent_tool_calls` had no production producer.** It was populated only by test
seeds and, in principle, the SDK. The collector accepted `tool_call` events
(envelope-only validation) yet the ch-insert router *dropped* them (`routeSkip`,
"no standalone table yet"). So the entire risk engine ran on no real data.

This is the first of ADR-027's deferred follow-ups: give the risk engine a
real, gateway-agnostic data source.

## Decision

Turn the existing, severed `tool_call` seam into an end-to-end path, reusing the
Phase-1 OTel front door (ADR-022) so any OTel-instrumented agent stack becomes a
source without code changes.

### Collector — recognize tool/MCP spans

`handleOTel` now classifies each span before mapping: a **tool span** (OTel
GenAI `gen_ai.operation.name = execute_tool`, or a `gen_ai.tool.name` attribute)
is mapped by `spanToToolEvent` to a canonical `tool_call` event; everything else
falls through to the existing `spanToEvent` (llm_call) path. Tool spans are
claimed **first**, and `spanToEvent` carries a guard, so a tool span is never
misread as an llm_call even if it also carries a `gen_ai.operation.name` marker.

Mapping: `tool_call_id` ← `gen_ai.tool.call.id` → span id → trace id;
`tool_name` ← `gen_ai.tool.name` → span name; `mcp_server` ←
`agentledger.mcp_server`/`mcp.server.name`; `agent_id`/`run_id` reuse the llm
path's attribution resolution. `source = "otel"`.

### Router — `tool_call` → `agent_tool_calls`

`route("tool_call")` now returns `(agent_tool_calls, routeInsert)` instead of
`routeSkip`; `agent_tool_calls` is added to the `isKnownTable` allowlist (the
injection-safety guard). No migration — the table already exists (CH 007).

### Validation — require the dedup key

`agent_tool_calls` is a `ReplacingMergeTree` ordered by
`(tenant_id, agent_id, tool_call_id)`. A missing `tool_call_id` would collapse
**every** tool call for an agent into one row, silently destroying the signal.
So the boundary validator now requires `tool_call_id` and `tool_name` for
`tool_call` events (in addition to the existing tenant/ts envelope check). This
is a deliberate strengthening of the envelope check rather than a full JSON
Schema; a formal `tool_call.schema.json` can follow (consistent with the other
non-llm kinds, which remain envelope-only).

### SDKs emit the dedup key

The Python and TypeScript SDK `record_tool_call`/`recordToolCall` now emit a
stable unique `tool_call_id` and an optional `mcp_server`, so SDK-sourced tool
calls dedup correctly too.

## Consequences

- The risk engine now has a real, gateway-agnostic producer: an OTel
  `execute_tool` span lands in `agent_tool_calls` and surfaces as unauthorized
  usage / exposure when it is not on the allowlist.
- A new `collector_otel_tool_spans_converted_total` metric tracks tool-span
  conversion separately from llm spans.
- Unit coverage: collector span mapping (incl. id/name fallbacks and a mixed
  llm+tool trace), the strengthened validator, and the router; plus a compose
  e2e (`tests/e2e/test_tool_span_ingestion.py`).
- Still deferred from ADR-027 (each additive on this signal): the semantic LLM
  risk-enrichment worker, NHI credentials/approval/decommission, and inline
  gateway tool enforcement.
