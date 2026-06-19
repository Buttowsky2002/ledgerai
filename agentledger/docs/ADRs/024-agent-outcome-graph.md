# ADR-024 — Agent Outcome Graph: explicit schema, NHIs, trace view

**Date:** 2026-06-19
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 3 (CLAUDE.md — "the moat"); ADR-016 (outcome connectors); ADR-018 (attribution matcher); ADR-010 (RLS)

---

## Context

Phase 3 names a **Graph schema (`schemas/graph/`, Postgres + ClickHouse)** with
"identities as first-class incl. non-human identities (NHIs) for agents;
outcomes; edges with `attribution_confidence`", and an acceptance bar that
`cost → agent → outcome → value` is queryable with a confidence on every edge.

The pieces existed but the graph was *implicit*: the attribution matcher
(ADR-018) writes `attribution_confidence` onto `outcomes`, `agent_runs` holds
cost, and humans/agents lived in two unrelated Postgres tables (`identities`,
`agents`). There was no formal schema, no first-class NHI, and no single trace
query. Rather than rebuild, this ADR formalizes and unifies what exists.

## Decision

1. **Formal contract** — `schemas/graph/outcome_graph.schema.json` (JSON Schema
   draft 2020-12) defines node types (identity{human|agent}, agent_run, outcome)
   and edge types, with `attribution_confidence ∈ [0,1]` required on **every**
   edge. `schemas/graph/README.md` maps each node/edge to its physical table/view.
   Only the `produced` edge (run → outcome) is probabilistic; all others are
   structural/deterministic (confidence 1.0).

2. **NHIs first-class via a view** — `v_identities` (Postgres migration 005)
   UNIONs `identities` (human) and `agents` (agent) into one identity set with
   `identity_type`. Chosen over a schema migration (adding `identity_type` + FK,
   folding agents into `identities`) because the view is **non-destructive** —
   RLS policies, Prisma models, the API and dashboard keep using the base tables
   unchanged. `security_invoker = true` so tenant RLS applies as the querying
   role (verified: 0 cross-tenant rows as `agentledger_api`).

3. **End-to-end trace** — `v_outcome_graph` (ClickHouse migration 005) joins
   `outcomes → agent_runs` (both `FINAL`) into one row per outcome exposing
   `ai_cost_usd`, `agent_id`, `business_value_usd`, `net_value_usd`,
   `attribution_confidence`, and `headline_eligible` (≥ 0.5).

4. **Headline low-confidence exclusion** stays at the API/UI layer (the
   `unit-economics` `minConfidence` param; the dashboard headline defaults to
   0.5 with an unfiltered baseline) — already implemented and e2e-tested, so
   `v_unit_economics` is left unchanged to avoid a second, divergent source of
   truth.

## Consequences

- The graph is now a documented contract, agents are queryable as identities,
  and the full value chain is one `SELECT` with confidence on every edge.
- `v_identities` and `v_outcome_graph` are read models over existing tables — no
  new write paths, no migration risk to live data.
- Deeper NHI modeling (an `identity_type` column, agent↔identity FK) is deferred;
  the view is sufficient for the graph and Phase 5 risk work can revisit it.
