# ADR-012 — Control-Plane CRUD Resources + Audit Log

**Date:** 2026-06-17
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 3 (CLAUDE_CODE_BUILD_SPEC.md §3); security rules 5, 6, 10; ADR-010 (RLS), ADR-011 (auth/RBAC)

---

## Context

Tasks 1–2 gave `services/api` its RLS spine and OIDC/JWT auth + RBAC, but no resource
management. Task 3 adds CRUD for all 10 control-plane resources — teams, identities, apps,
agents, virtual_keys, policies, budgets, price_book, allocation_rules, tenants — with an
audit trail for every mutation (rule 10). Isolation (ADR-010) and role gating (ADR-011)
already exist; this task composes on top of them rather than re-implementing either.

---

## Decision

### One generic, RLS-scoped CRUD base

`CrudService` (`src/common/crud.service.ts`) implements list/get/create/update/delete and is
configured per resource with `{ model, idField, object }`. Every operation runs inside
`PrismaService.withTenant(getTenantId(), …)` — the ADR-010 transaction-scoped `set_config`
— so Postgres RLS confines it to the caller's tenant. Consequences that fall out for free:

- **No `where: { tenantId }` in handlers.** Isolation is the database's job. Create injects
  `tenant_id = app.tenant_id`; a row from another tenant is invisible, so get/update/delete
  on a foreign id returns **404** (no cross-tenant existence leak).
- Thin per-resource controllers expose REST under `/v1/<resource>` (list with `?limit`/
  `?offset`, default 50, max 100; bare arrays, matching task 1's teams shape). Create/update
  use per-resource `class-validator` DTOs; the global `ValidationPipe` rejects unknown fields
  (rule 5). **RBAC: reads `@Roles('viewer')`, writes `@Roles('admin')`** (the chosen matrix).

### Audit every mutation, atomically (rule 10)

`recordAudit(tx, …)` (`src/common/audit.ts`) writes an `audit_log` row **inside the same
transaction** as the mutation, so the change and its audit commit together (or not at all),
and the audit row's `tenant_id` equals `app.tenant_id` (RLS `WITH CHECK` passes). Convention:
`actor = principal.userId ?? 'system'`, `action ∈ {create,update,delete}`,
`object = '<resource>:<id>'`, `detail = { before, after }`. update/delete read the prior row
first to capture `before`; before/after are JSON-flattened (Decimal/Date → plain JSON).

### Resource-specific shapes

- **virtual_keys** — `POST` mints `alk_` + 24 random bytes hex, stores `sha256hex(plaintext)`
  in `key_hash` (mirrors the gateway's `sha256hex`, so minted keys authenticate), and returns
  the plaintext **exactly once** (rule 6). The hash is never returned and never logged (audit
  records the sanitized row). `DELETE` is a soft **revoke** (`revoked_at`), so existing
  references and the gateway's `revoked_at IS NULL` filter behave correctly.
- **price_book** — global reference data (no `tenant_id`, no RLS). Migration `004` grants the
  API role write access, **reversing 002's read-only stance** now that the API manages the
  price book; authorization is purely `@Roles` (reads viewer, writes admin). It reuses
  `CrudService` with `injectTenant:false`; the wrapping `withTenant` transaction is still used
  so the audit row picks up the acting admin's tenant.
- **tenants** — `GET/PATCH /v1/tenant` act on the caller's **own** tenant only (RLS makes
  exactly one row visible). Tenant **provisioning (create/delete) is out of scope**: it is
  inherently cross-tenant and RLS-blocked, and belongs to a separate system/admin path.

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| Per-resource bespoke services | 10× boilerplate and 10× the chance of forgetting audit or the RLS transaction. One audited base keeps the guarantees uniform. |
| App-level `where: { tenantId }` filters | Redundant with RLS and a footgun if forgotten; RLS already enforces it at the DB. |
| Hard-delete virtual keys | Loses the audit/reference trail and races the gateway's key cache; soft revoke is safer. |
| Keep price_book API read-only | Task 3 requires managing the price book; granting write (admin-gated) is the point. |
| Audit in a separate transaction / interceptor | Not atomic with the mutation; a crash could record a change that rolled back (or miss one). |

---

## Consequences

- **Positive**: Uniform, tenant-safe CRUD with guaranteed audit; new resources are a thin
  controller + DTOs. Cross-tenant access fails closed (404) by construction.
- **Positive**: Minted keys are gateway-compatible; plaintext shown once; hash never leaves
  the DB.
- **Negative / scope**: No list filtering/sorting beyond limit/offset yet; tenant
  provisioning and bulk ops are deferred. price_book is globally writable by any tenant's
  admin (it is shared reference data) — acceptable and audited; finer governance can come
  later.
- **Operational**: Migration `004` widens the API role's grant on `price_book`. The audit
  trail now populates `audit_log`; downstream retention/export honors it.
