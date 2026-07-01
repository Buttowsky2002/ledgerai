# ADR-010 — Control-Plane API Foundation + Tenant Isolation via Postgres RLS

**Date:** 2026-06-17
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 3 (CLAUDE_CODE_BUILD_SPEC.md §3); security rules 3, 5, 6, 7; ARCHITECTURE.md (Go data plane / TypeScript control plane)

---

## Context

Phase 3 adds the control plane: a NestJS + Prisma API on Postgres, dashboards, and
Postgres row-level security. This is the repo's first TypeScript service. This ADR
covers **task 1 — the foundation and the tenant-isolation spine**. AuthN/AuthZ, CRUD,
analytics, OpenAPI/TS-client, and the dashboard are follow-on tasks.

The phase's headline acceptance bar is *"cross-tenant access test fails closed (tenant
A token cannot read tenant B by any route)"*, and security rule 3 mandates RLS on every
tenant-scoped table **in the same phase the API lands**. So isolation must be real and
tested before any data route exists — not retrofitted later.

---

## Decision

### NestJS + Prisma; SQL stays the source of truth

The API is NestJS 10 + Prisma 5. **Prisma is a typed query client only** — `schema.prisma`
is hand-authored to mirror `deploy/postgres/001_core.sql`, and we do **not** use
`prisma migrate`. Database structure remains owned by the forward-only numbered SQL
migrations (repo rule), so there is exactly one source of truth and no drift between two
migration systems. RLS, policies, and roles live in `002_rls.sql`, not in Prisma.

### Tenant isolation = `FORCE` RLS + transaction-local GUC

`002_rls.sql` enables `ENABLE` + `FORCE ROW LEVEL SECURITY` on all 11 tenant-scoped
tables (`tenants`, `teams`, `identities`, `apps`, `agents`, `virtual_keys`, `policies`,
`allocation_rules`, `budgets`, `connectors`, `audit_log`). Each policy compares
`tenant_id` to `app_current_tenant()`, defined as:

```sql
nullif(current_setting('app.tenant_id', true), '')::uuid
```

The API binds that GUC per request inside a Prisma **interactive transaction**, as the
first statement:

```ts
this.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId ?? ''}, true)`;
  return fn(tx);
});
```

The `true` argument is the crux: it makes the binding **`SET LOCAL`** — scoped to the
transaction, reset when it ends. A plain `SET` (session-level) would persist on the
pooled connection and bleed one tenant's context into the next request that reuses it —
a cross-tenant data leak. Transaction-local binding makes that structurally impossible,
which is why handlers carry **no** `where: { tenantId }` filters: isolation is the
database's job, enforced uniformly, not per-query app discipline that one forgotten
filter could defeat.

### Fail closed

`current_setting(…, true)` returns NULL when unset (missing_ok); `nullif(…, '')` maps an
empty binding to NULL too (so `''::uuid` never errors). NULL makes every policy predicate
false → zero rows, no error. No tenant context ⇒ sees nothing.

### Least-privilege role; API must not be a superuser

`002_rls.sql` creates a non-superuser, non-`BYPASSRLS` role `agentledger_api` with
table-level CRUD grants (read-only on the global `price_book`). The API connects as this
role so it is always subject to RLS. **`FORCE` matters because the dev bootstrap user
`agentledger` is a superuser and would bypass RLS** — the API must use `agentledger_api`,
and `FORCE` additionally subjects even the table owner. The role is created `NOLOGIN`
with **no password in the migration** (it is forward-only and runs in production); the
login + password are granted out-of-band — by a secret manager in prod, and by
`deploy/postgres-dev/dev_api_role.sql` (a dev-only mount, not a numbered migration) for
the local stack.

### `roi_templates`: tenant rows + shared built-in packs

`roi_templates.tenant_id` is nullable (NULL = built-in pack). Split policies: SELECT
allows `tenant_id = app_current_tenant() OR tenant_id IS NULL`; INSERT/UPDATE/DELETE
restrict to `tenant_id = app_current_tenant()`, so a tenant can read built-ins but never
mutate them or another tenant's templates. `price_book` is global reference data with no
`tenant_id` — RLS stays off; the API role has SELECT only.

### Tenant source is a stand-in until task 2

Tenant id flows through an `AsyncLocalStorage` request context set by `TenantMiddleware`.
Until OIDC/JWT lands (task 2), it is read from an `x-tenant-id` header honored **only**
when `BADGERIQ_DEV_TRUST_HEADER=true`. Task 2 swaps the source for verified JWT claims;
the RLS machinery it feeds is the permanent, real mechanism and does not change.

### Service shape

`services/api/` mirrors the other services' conventions: `AGENTLEDGER_*` env vars,
`/healthz` `/readyz` `/metrics`, structured JSON logs (pino, matching slog's shape),
distroless/nonroot container. Boundary hardening: global `ValidationPipe`
(`whitelist` + `forbidNonWhitelisted` → unknown fields rejected, rule 5), body-size
limit, and an RFC-7807 problem+json exception filter that never leaks internals.

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| Schema-per-tenant or database-per-tenant | Strong isolation but heavy operationally (migrations × N tenants, connection sprawl); RLS gives row-level isolation in one schema with one migration path. |
| App-level `WHERE tenant_id = ?` everywhere | One forgotten filter = a silent cross-tenant leak; not enforceable by the DB. RLS is defense-in-depth that holds even if a query is wrong. |
| Session `SET app.tenant_id` (not `SET LOCAL`) | Persists on pooled connections → leaks across requests/tenants. Transaction-local is mandatory under pooling. |
| Connection-per-tenant pool | Defeats pooling efficiency and explodes connection count; transaction-scoped GUC reuses one pool safely. |
| Prisma owns schema via `prisma migrate` | Two competing migration systems on one DB; repo rule is forward-only numbered SQL. Prisma maps, doesn't migrate. |

---

## Consequences

- **Positive**: Tenant isolation is enforced by Postgres for *every* current and future
  query, not per-handler discipline. Cross-tenant reads **and** writes (WITH CHECK) fail
  closed, proven by `test/tenant-isolation.e2e-spec.ts` including a pooled-connection
  no-leak case — the permanent rule-3 acceptance test.
- **Positive**: One source of truth for schema; no Prisma/SQL drift.
- **Negative / scope**: Tenant comes from a dev-trusted header until task 2 — safe only
  because it is gated behind `BADGERIQ_DEV_TRUST_HEADER` and replaced by JWT next.
- **Operational**: The API **must** connect as `agentledger_api`, never the superuser, or
  RLS is bypassed. Enforced in docker-compose and documented; prod wires the role
  password via secret manager. Connector rows referenced by ADR-007 are now managed here.
- **Negative**: Every DB access pays one extra round-trip (`set_config`) per transaction.
  Negligible for control-plane volumes; analytics endpoints (task 4) hit ClickHouse, not
  this path.
