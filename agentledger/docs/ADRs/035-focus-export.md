# ADR-035 — FOCUS 1.2 cost export

**Date:** 2026-06-21
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 6 (CLAUDE.md — "FOCUS 1.2 export with x_ai_*"); ADR-013 (analytics over ClickHouse MVs — reuses its `queryScoped` tenant-isolation pattern); the binding decision in `docs/ARCHITECTURE.md` that FOCUS 1.2 is the canonical export schema.

---

## Context

BadgerIQ's buyer is the FinOps lead, who already runs cloud bills through
[FOCUS](https://focus.finops.org/)-aware tooling. There was **no way to get AI
spend out** in that format — no `schemas/focus/`, no export. CLAUDE.md mandates a
"FOCUS 1.2 export with `x_ai_*`."

## Decision

Add `GET /v1/analytics/focus-export?from=&to=&format=csv|json` to the analytics
module. It is generated **on demand** from the existing `spend_daily` ClickHouse
MV (one charge per day × team × app × provider × model) — nothing is persisted,
and per rule 2 it carries **cost/usage/attribution dimensions only**, never
content.

- **Schema as contract:** `schemas/focus/focus-1.2.columns.json` defines the FOCUS
  base columns we populate + the `x_ai_*` extension registry, and is the canonical
  **CSV column order**; `README.md` documents the `spend_daily → FOCUS` mapping.
  `BilledCost`/`EffectiveCost`/`ListCost` all map to `cost_usd` (no negotiated-rate
  distinction today); `ServiceName`←model, `ProviderName`←provider, `ResourceId`←
  app. Extensions: `x_ai_provider/model/team_id/app_id/{input,output,cached}_tokens/calls`.
- **Reuse, don't reinvent:** the endpoint uses `ClickHouseService.queryScoped`, so
  `tenant_id` is bound from the JWT principal, never request input (rule 3) — the
  same isolation ClickHouse analytics already rely on (no RLS there). The date
  range reuses the analytics `range()` default (last 30 days).
- **Serialization is hand-rolled** (rule 12 — no CSV dependency): `focus.mapper.ts`
  maps a row to the FOCUS record and emits RFC-4180-escaped CSV in the schema's
  column order. `format=csv` (default) returns `text/csv` + a `Content-Disposition`
  attachment; `format=json` returns the rows.
- **Audited (rule 10):** an export is a data egress, so it writes an `audit_log`
  row (`action='export'`, object `focus-export:<from>:<to>`, row count) inside a
  tenant-bound transaction.

## Consequences

- **Positive:** AI spend folds into a customer's existing FinOps tooling; the
  `x_ai_*` extensions keep it sliceable by model/team/tokens. No new dependency, no
  new storage, no migration — purely a read over an existing MV.
- **Trade-offs / accepted:** `spend_daily` is aggregated above the agent, so
  `x_ai_agent_id` is intentionally absent (agent-grain FOCUS lines from
  `spend_hourly_by_key` are a future ADR if a customer needs them). Cost columns are
  triplicated from one source until negotiated rates exist. The schema `version` is
  pinned in the JSON — changing the column set needs a bump + a new ADR (importers
  depend on the order).
- **Verification:** unit tests for the mapper (row→FOCUS, RFC-4180 escaping, empty
  result); api e2e seeds `llm_calls` (MV auto-populates `spend_daily`) and asserts
  the JSON export's FOCUS+`x_ai_*` columns, summed cost, CSV header/attachment, and
  tenant isolation (tenant A's export excludes tenant B's app/model).
