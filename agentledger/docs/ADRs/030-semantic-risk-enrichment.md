# ADR-030 — Semantic risk-enrichment worker (LLM tier)

**Date:** 2026-06-20
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 6; ADR-027 (agent-native risk engine — the deterministic tier this complements); ADR-029 (OTel tool-span ingestion — the producer of the data this reads)

---

## Context

ADR-027 shipped the **deterministic** risk tier: observed tool calls vs a
deny-by-default allowlist → governed `risk_events` + `agent_risk`. It explicitly
deferred the **semantic** tier — an LLM classifier for risks the deterministic
rules can't express: suspected prompt injection, data egress, privilege
escalation, anomalous tool sequences. ADR-029 then gave the engine a real
producer (`agent_tool_calls`). This ADR adds the semantic tier on top.

## Decision

A new opt-in worker, `services/workers/cmd/risk-enrichment` (`internal/riskenrich`).

### Reads metadata only — never content

The classifier reasons over **tool-call metadata only**: the ordered tool-name
sequence per run, the MCP servers seen, and the call count (read from
`agent_tool_calls` via a `groupArray` over a ts-ordered subquery). It never sees
prompt/completion content — none is stored, and the analytics pipeline must never
gain a raw-content field (CLAUDE.md rule 2). "Semantic" here means LLM reasoning
over the *behavioral pattern*, not over text.

### LLM access via stdlib HTTP, not a vendor SDK

The Anthropic Messages API is called over stdlib `net/http`, consistent with how
every other worker/connector reaches ClickHouse and provider APIs (no vendor SDK;
CLAUDE.md rule 12 / dependency minimalism). The default model is
`claude-opus-4-8` (override via `AGENTLEDGER_RISK_ENRICH_MODEL`). Output is
constrained with `output_config.format` (JSON Schema) so the verdict parses
deterministically; `temperature`/`thinking` are omitted (rejected on the 4.8
surface). A `stop_reason: "refusal"` yields an empty assessment (the run is simply
not enriched) rather than stalling the pass. The API key comes from
`ANTHROPIC_API_KEY` (env-var name only; rule 1) and is never logged.

The `Classifier` interface keeps the engine unit-testable against a mock; the
live HTTP client is tested with `httptest`.

### Opt-in and async — gated on the deterministic tier

The worker is **disabled by default**: the enrichment loop runs only when
`AGENTLEDGER_RISK_ENRICH_ENABLED=true` and an API key is present; otherwise it
serves health endpoints and does nothing. This honors ADR-027's "gated on the
deterministic tier's precision, never on the inline path." Findings below a
confidence threshold (`AGENTLEDGER_RISK_ENRICH_MIN_CONFIDENCE`, default 0.5) are
dropped, so the semantic tier is clearly probabilistic.

### Writes into the shared risk_events table — no migration

Findings are written as `risk_events` with `category = "semantic_<finding>"`, a
deterministic `event_id` (`se_<hash(tenant|agent|run|category)>`) so repeated
passes upsert rather than duplicate, and `detail = "tier=semantic confidence=…;
<rationale>"`. Reusing the existing table (CH 007) means semantic findings appear
in the CISO surface alongside deterministic ones with **zero migration**. A
dedicated `confidence`/`tier` column can follow if the dashboard needs to filter
on them.

## Consequences

- The risk engine now has both tiers: deterministic governance (authoritative)
  and an opt-in LLM tier for behavioral risk, both surfacing as `risk_events`.
- No new dependency (stdlib HTTP); no migration; no API/dashboard change required.
- Unit coverage: engine with a mock classifier (confident findings written,
  low-confidence/benign dropped, deterministic ids, classifier errors skipped)
  and the Anthropic HTTP client with `httptest` (request shape + structured
  output parsing + refusal handling).
- **Still deferred from ADR-027:** NHI short-lived credentials / approval /
  decommissioning (next, C3) and inline gateway tool enforcement (C4).
- **Operational note:** enabling this incurs LLM cost per run scanned; the
  interval, lookback, min-calls, and min-confidence knobs bound it, and it stays
  off until an operator opts in.
