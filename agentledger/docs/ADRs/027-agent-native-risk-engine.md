# ADR-027 — Agent-Native Risk Engine

**Date:** 2026-06-20
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 5 (CLAUDE.md — the DLP pivot); ADR-009 (reconcile worker); ADR-024 (outcome graph); ADR-026 (risk-adjusted ROI)

---

## Context

Phase 5 turns AgentLedger's risk story agent-native: per-agent tool/MCP
governance, governed risk events, and a risk signal that feeds the risk-adjusted
ROI seam (`agent_risk`) ADR-026 built. The deterministic DLP regex tier
(`gateway/dlp.go`) already exists and carries forward. There was no per-tool-call
signal and no agent-level risk attribution.

## Decision

### Scope this phase

Build the **acceptance core + deterministic** tier; defer the semantic LLM
classifier and NHI credential issuance/approval workflows to a follow-up (the
`agent_risk` seam makes them additive).

### Observe, don't require the gateway

Governance is an **async observational worker**, not inline gateway enforcement —
consistent with the gateway-agnostic pivot, so it works whether or not a gateway
is in path. Per-tool-call signal lands in a new ClickHouse `agent_tool_calls`
table (seed/SDK now; OTel tool-span ingestion later).

### Components

- **Allowlist (control plane)** — Postgres `agent_tool_allowlist` (deny-by-default,
  RLS + audit via CrudService). `/v1/agent-tool-allowlist` CRUD projects each
  entry into ClickHouse `agent_tool_allow` (allowed=1 on create, allowed=0
  tombstone on delete), mirroring the roi_rates projection.
- **risk-engine worker** (`services/workers/cmd/risk-engine`) — reads the
  governance views (`v_unauthorized_tools`, `v_agent_tool_exposure`; deny-by-default
  via LEFT ANTI JOIN), raises one governed `risk_events` row per (agent, disallowed
  tool) with deterministic id (idempotent) and severity escalating on repeated use,
  and writes each agent's `risk_exposure_pct = unauthorized/total tool calls` to
  `agent_risk`.
- **CISO surface** — `GET /v1/analytics/agent-risk` (agent risk register) + the
  dashboard `/ciso` view. Exposure flows into `v_roi` → risk-adjusted ROI (CFO view).

### Why overrides/exposure live in ClickHouse tables, not on `outcomes`/`agents`

The attribution matcher re-inserts whole outcome rows; risk lives in its own
tables joined at read time, so nothing clobbers it.

## Consequences

- Acceptance met end-to-end: a seeded agent that calls a disallowed tool raises a
  governed risk event (Go integration test: tool calls → worker → event +
  `agent_risk` → `v_roi` ROI drops; api e2e: event in CISO register + ROI
  discounted, allowlist CRUD projects to CH).
- **Deferred:** the semantic LLM classification worker
  (`services/workers/risk-enrichment/`), NHI short-lived credentials + approval
  workflows + dormant decommissioning, OTel tool-span ingestion, and inline
  gateway enforcement. The schema/seams are in place so each is additive.
