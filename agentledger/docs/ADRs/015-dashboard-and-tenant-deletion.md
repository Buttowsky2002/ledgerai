# ADR-015 — Next.js Dashboard + Tenant Data-Deletion Job

**Date:** 2026-06-17
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 3 (CLAUDE_CODE_BUILD_SPEC.md §3); security rules 5, 13, 14; ADR-010..014

---

## Context

The last Phase 3 task: the operator-facing **dashboard** and the **tenant data-deletion job**
(security rule 14 — "implement tenant data deletion (cascade + ClickHouse `ALTER DELETE`) in
Phase 3"). The dashboard consumes the typed client from ADR-014; the deletion job exercises the
two stores the control plane owns.

---

## Decision

### Dashboard — Next.js 14 App Router, server-side typed client (BFF)
`apps/dashboard` renders every data page as a **React Server Component** that calls the API
**server-side** via the generated `@badgeriq/shared-types` client (`lib/api.ts`). No token
or API surface reaches the browser, and there's no CORS. Auth resolution: a session
`al_access` cookie → `Authorization: Bearer` (prod, post-OIDC); otherwise
`BADGERIQ_DEV_TENANT_ID` → `x-tenant-id` (dev, the API trusts it behind
`BADGERIQ_DEV_TRUST_HEADER`). Settings **writes** go through Next route handlers
(`app/api/*`) so they too stay server-side; **virtual-key create surfaces the plaintext once**.

Pages: Executive spend, Allocation (team/app/agent), Model mix, Budgets + burn-down, Risk
events, Agent detail, Settings (keys/policies/budgets CRUD). `recharts` for the few charts;
dense tables elsewhere. Untrusted API content (DLP/risk strings) is rendered through React's
default escaping — no `dangerouslySetInnerHTML` (rules 5/13).

### Tenant data-deletion — an API command (`src/cli/delete-tenant.ts`)
Run via `NestFactory.createApplicationContext(AppModule)` (DI + connections, no HTTP):
`npm run delete-tenant -- <tenantId>`. It reuses the existing connections instead of a new
service:
- **Postgres**: in the tenant's RLS context, delete `audit_log` (no FK) then `DELETE FROM
  tenants`, which **cascades** to every tenant table (`ON DELETE CASCADE`, `001_core.sql`).
- **ClickHouse**: `ALTER TABLE … DELETE WHERE tenant_id = {tenant:String} SETTINGS
  mutations_sync = 1` (parameterized, synchronous → verifiable) on each data table
  (`llm_calls`, `agent_runs`, `outcomes`, `provider_costs`, `cost_adjustments`,
  `spend_daily`, `spend_hourly_by_key`, `risk_daily`).
- Emits a structured JSON audit line (the tenant's own `audit_log` is being erased).

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| Client-side data fetching (token in browser) | Exposes the token + needs CORS; BFF server components keep both server-side. |
| Tenant deletion as a Go worker | A new binary/language for a control-plane op the API can do reusing Prisma + ClickHouseService. |
| Deletion as an HTTP endpoint | Too easy to fire destructively; a deliberate CLI job is safer for an irreversible erase. |
| Heavier SDK/data lib | The generated `openapi-fetch` client already gives typed calls; no extra layer needed. |

---

## Consequences

- **Positive**: One typed path from API → dashboard (a wrong field/route is a build error —
  proven by `next build`). Tenant erasure is complete across both stores and verifiable
  (synchronous CH mutation + PG cascade).
- **Negative / scope**: Live Google/Microsoft SSO needs provider credentials we don't have —
  the dashboard runs in dev via the `x-tenant-id` header; the OIDC flow is wired but the
  cross-origin token→session handoff is left for prod hardening. Deletion has no UI trigger
  (CLI only) and no "soft-delete/grace period" — it is immediate and irreversible.
- **Operational / deferred**: the dashboard is **not** containerized in docker-compose (its
  `file:` dependency on `packages/shared-types` needs a repo-root Docker build context);
  run it with `npm run dev`/`start`. Tracked for a later compose/Helm pass.
- Completes Phase 3.
