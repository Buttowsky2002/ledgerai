# ADR-013 — Dashboard Analytics over ClickHouse Materialized Views

**Date:** 2026-06-17
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 3 (CLAUDE_CODE_BUILD_SPEC.md §3); security rules 3, 4, 12; ADR-006/011/012; ARCHITECTURE.md (ClickHouse + incremental MVs)

---

## Context

Phase 3 task 4 adds the read-only analytics API behind the dashboards. The spec is explicit:
**analytics endpoints query ClickHouse MVs only, never raw `llm_calls`**, and the dashboard
budget is **p95 < 300ms against 50M rows**. The control-plane API has so far only spoken to
Postgres (Prisma); this is its first ClickHouse access.

The defining constraint: **ClickHouse has no row-level security.** Postgres RLS (ADR-010)
does not help here. Tenant isolation must be enforced by the API itself, on every single
query, and must be impossible to bypass via request input.

---

## Decision

### MVs only, re-aggregated

Every endpoint reads a SummingMergeTree aggregate (`spend_daily`, `spend_hourly_by_key`,
`risk_daily`) or the `v_unit_economics` view (plus `agent_runs FINAL` for agent detail) —
never `llm_calls`. Because Summing rows may be unmerged, queries **re-aggregate**
(`sum(...) … GROUP BY`) rather than trusting one row per key. These tables are ordered
`tenant_id`-first, so the tenant filter prunes partitions/granules efficiently — the basis for
the latency budget.

### Tenant isolation = injected, bound parameter (the core security property)

A small `ClickHouseService` (Node global `fetch` over the HTTP interface — **no new
dependency**, mirroring the workers' stdlib JSONEachRow client and the gateway's
dependency-minimalism, rule 12) exposes `queryScoped(sql, params)`, which **always** binds
`param_tenant` from `getPrincipal().tenantId` and fails closed if there is no principal. Every
analytics query filters `WHERE tenant_id = {tenant:String}`. The tenant value comes only from
the verified JWT — never from a query string, path, or body (rule 3).

### Parameterized, never interpolated

All inputs (tenant, date range, agent id, virtual-key id, outcome type) are passed as
ClickHouse `param_<name>` values and referenced as `{name:Type}` placeholders, so ClickHouse
substitutes them server-side (rule 4 — no string-concatenated SQL, including ClickHouse). The
only values placed into SQL text are fixed column identifiers chosen from a **validated enum**
(e.g. allocation `dimension` → `team_id`/`app_id`), which are never user-supplied strings.

### Shape

`/v1/analytics/*`, all `@Roles('viewer')` (read-only): `spend`, `allocation`
(`?dimension=team|app|agent`), `model-mix`, `burndown` (hourly + window cumulative), `risk`,
`unit-economics`, `agents/:agentId`. Query params validated by `class-validator` DTOs with
sensible date-range defaults. `/readyz` now also pings ClickHouse.

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| `@clickhouse/client` dependency | Adds a dep for what HTTP + bound params already do cleanly; stdlib-style fetch keeps parity with the data plane. |
| Query raw `llm_calls` | Violates spec §3 and blows the latency budget; MVs exist precisely for this. |
| Tenant from a request param/header | Trivially bypassable cross-tenant read; tenant must come from the JWT only. |
| Lean on a DB-level guard | ClickHouse has no RLS; there is no DB guard to lean on — the app is the only enforcement point. |
| One row per Summing key (no re-aggregate) | Returns partial sums before background merge; must `sum()`/`GROUP BY`. |

---

## Consequences

- **Positive**: Dashboards get every panel's data from MVs with one uniform, parameterized,
  tenant-injected client; no new dependency. Cross-tenant reads are impossible by construction
  (proven by an e2e where a tenant-B token never sees tenant-A aggregates).
- **Negative / scope**: Tenant isolation here is application-enforced, not DB-enforced — so the
  `queryScoped` discipline is load-bearing and covered by tests; a future raw-`query` caller
  must remember the filter (only `ping`/health uses the unscoped `query`).
- **Operational**: API now depends on ClickHouse (compose `depends_on` + `/readyz` ping; new
  `AGENTLEDGER_CLICKHOUSE_*` env). The p95 < 300ms @ 50M-row proof is a seeded-environment/CI
  concern, not verified locally; the MV + tenant-first ordering is the design basis for it.
