# ADR-046 — Outcome Graph MVP API (agents ROI, runs, outcomes)

**Date:** 2026-06-23
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 3 (the Agent Outcome Graph) and Phase 4 (ROI engine); ADR-013 (analytics
over ClickHouse views), ADR-024 (`v_outcome_graph`), ADR-026 (`v_roi`), ADR-045 (bulk import);
security rules 2/3/4/5/10.

---

## Context

The Outcome Graph MVP asked for a data model (`agent_runs`, `llm_calls`, `tool_calls`, `outcomes`,
a per-agent daily unit-economics view) and five endpoints (`GET /v1/agents`, `GET /v1/agents/:id/roi`,
`GET /v1/runs/:id`, `GET /v1/outcomes`, `POST /v1/outcomes`), with three acceptance criteria: demo
data shows cost per outcome; the agent detail page shows the evidence chain cost→outcome; the API is
tenant-scoped.

Most of the model already exists from Phases 1–4 and the attribution engine: ClickHouse `agent_runs`,
`llm_calls`, `agent_tool_calls`, `outcomes`, and the `v_roi` / `v_outcome_graph` / `v_unit_economics`
views; the demo seed already produces cost-per-outcome data; `GET /v1/agents` already exists. The work
is therefore a **reconciliation + gap-fill**, not a rebuild.

## Decision

**1. Reconcile to the existing schema — do not duplicate tables or add producerless columns.**
The spec's names map onto what exists: `tool_calls` → `agent_tool_calls`; `outcomes.value_usd` →
`business_value_usd`; `confidence` → `attribution_confidence`; `source` → `source_system`;
`occurred_at` → `ts`; `agent_runs.risk_score` is derived from `agent_risk.risk_exposure_pct` (via
`v_roi`). The spec's extra tool-call columns (`action`/`cost_usd`/`latency_ms`/`risk_severity`) and
`agent_runs.team_id`/`risk_score` are **not** added: nothing produces them yet, and adding empty event
fields rubs against rule 2 (keep the event surface minimal). The field-name mapping happens at the API
layer (DTO/SELECT aliases).

**2. The only new storage object is a per-agent daily unit-economics view.**
`agentledger.v_agent_daily_unit_economics` (ClickHouse migration 010) aggregates `v_roi` by
`(tenant_id, agent_id, day)`, exposing `cost_usd`, `outcomes_count`, `value_usd`, `net_value_usd`,
`cost_per_success`, `attribution_confidence_avg`, `risk_adjusted_roi`. Building on `v_roi` keeps the
ROI math (confidence weighting, fully-loaded cost, risk discount) defined in exactly one place. It is
realized as a **view**, consistent with `v_roi`/`v_unit_economics`/`v_outcome_graph` (the JOINs make a
SummingMergeTree MV a poor fit); "materialized view" in the brief is satisfied semantically.
Column semantics: `cost_usd` is raw AI/token cost; `net_value_usd` and `cost_per_success` use
**fully-loaded** cost (finance-grade); `cost_per_success` counts headline-eligible outcomes
(confidence ≥ 0.5) and is NULL when there are none.

**3. `POST /v1/outcomes` is a direct ClickHouse insert, parallel to `ImportService`.**
The endpoint validates a DTO and writes one row into the canonical `outcomes` table via
`ClickHouseService.insertRows` (`source_system` defaults to `api`), `@Roles('analyst')`. `tenant_id`
is stamped from the request principal — never from the body (rule 3). There is no content field
(rule 2). The create is recorded in `audit_log` (rule 10) inside a tenant-bound transaction.
**At-least-once caveat:** ClickHouse is not enrolled in the Postgres transaction, so an audit failure
after a successful insert leaves the outcome written but unaudited (same window `ImportService`
documents). Acceptable for a manual/API create; never silent data loss. A `runId` on the body links
the outcome to its run so the existing attribution path can pick it up — this endpoint does **not**
itself write attribution edges (that stays the attribution worker's job).

**4. Reads follow the established analytics pattern.**
`GET /v1/agents/:id/roi`, `GET /v1/runs/:id`, and `GET /v1/outcomes` all read via
`ClickHouseService.queryScoped`, which fails closed unless the SQL binds `tenant_id = {tenant:String}`
from the principal; every other input is a bound parameter (rule 4). `:id`/`:agentId` are bound, never
interpolated. `GET /v1/runs/:id` returns the run plus its outcomes and tool calls (the run node of the
evidence chain) and 404s when absent. All reads are `@Roles('viewer')`.

## Consequences

- The agent detail page can show cost→outcome economics and link each outcome into the existing
  `/attribution?outcome=…` drill-down, completing the evidence chain without new graph storage.
- No new Postgres migration (audit uses the existing `audit_log`); one forward-only ClickHouse
  migration (010).
- The producerless spec columns remain a documented future item: if/when a tool-call producer emits
  action/cost/latency, they are additive ClickHouse `ALTER`s + a schema bump at that time.
