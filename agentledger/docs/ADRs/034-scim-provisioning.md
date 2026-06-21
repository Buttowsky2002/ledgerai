# ADR-034 — SCIM 2.0 provisioning

**Date:** 2026-06-21
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 6 (CLAUDE.md — SSO/SCIM); ADR-033 (enterprise SSO — this consumes its `identities.external_id`/`active` columns and completes the deprovisioning half); ADR-010 (control plane + RLS); ADR-011 (auth). Mirrors the hashed-secret-shown-once pattern of ADR-031 (NHI credentials).

---

## Context

ADR-033 gave enterprises per-tenant SSO with JIT provisioning, but onboarding via
login is only half the lifecycle: enterprises run their directory (Okta/Entra/…)
as the source of truth and expect it to **provision and — critically —
deprovision** users automatically via SCIM 2.0 (RFC 7643/7644). Without it, a
user offboarded in the IdP keeps a live AgentLedger identity until they happen to
try logging in. P6-D2 delivers the SCIM half. Scope (confirmed): **Users +
Groups→teams**.

## Decision

### Endpoint, auth, and tenant binding

A new `/scim/v2` module exposes the SCIM resources. Tenant IdPs authenticate with
a **per-tenant bearer token** (`scim_…`) issued through `/v1/scim-tokens`
(admin-only; SHA-256 hash stored, plaintext shown once — the ADR-031/virtual-keys
pattern). `ScimAuthGuard` resolves the token to its tenant via the
`scim_token_resolve()` **SECURITY DEFINER** function (migration 009) — SCIM auth
has no tenant context yet, so this is the sanctioned RLS bypass, the same shape as
the SSO login lookups. The resolved tenant is attached to the request and passed
**explicitly** to `withTenant(tenantId)` in every handler, so all reads/writes are
RLS-confined. SCIM routes are `@Public` to the JWT `AuthGuard` and carry the SCIM
guard instead.

Why explicit tenant passing rather than the usual `getTenantId()`/`CrudService`?
The global `AuthMiddleware` has already opened the request's `AsyncLocalStorage`
store (as anonymous) before any guard runs, and a guard cannot re-wrap the
downstream continuation — so the SCIM path threads the tenant explicitly instead
of relying on ambient context.

### Mapping

- **User ↔ identity:** `userName`/primary email → `email`; `externalId` →
  `external_id`; `active` → `active`; `name.formatted`/`displayName` →
  `display_name`; `source = 'scim'`. Create/replace/PATCH/filter
  (`userName eq`)/pagination (`startIndex`/`count`) supported. **DELETE
  soft-deactivates** (`active = false`) rather than hard-deleting — `identities`
  is referenced by `agents.owner_user_id`, `manager_id`, and the audit trail, so a
  hard delete would break referential integrity or lose history. Deactivation is
  exactly what ADR-033's login path already refuses (`auth_lookup_identity` filters
  `active = true`), so SCIM deprovisioning immediately blocks SSO.
- **Group ↔ team:** `displayName` → `teams.name` (tracked by `external_id`);
  `members` set each identity's `team_id`. **Single primary-team model:** an
  identity has one `team_id`, so membership in multiple SCIM Groups reflects only
  the most-recently-applied team. Full many-to-many membership (a
  `team_memberships` join table) is deferred — it would ripple into attribution,
  which keys on `identity.team_id`, and isn't needed for the provisioning lifecycle.

### Protocol surface

Hand-rolled, no SCIM library (dependency minimalism, rule 12 — SCIM is JSON
shaping plus a focused PATCH-op reducer): discovery (`ServiceProviderConfig`/
`ResourceTypes`/`Schemas`), `ListResponse`, and the
`urn:ietf:params:scim:api:messages:2.0:Error` envelope with SCIM status/`scimType`
(`uniqueness` → 409, `invalidValue` → 400). The PATCH reducer supports the ops
Okta and Entra actually emit (`replace active`, attribute replaces, no-path value
objects); unsupported ops are accepted and ignored rather than erroring.

## Consequences

- **Positive:** the IdP becomes the lifecycle source of truth; offboarding in the
  directory deactivates the AgentLedger identity within one sync and blocks login
  immediately. Every SCIM mutation is RLS-confined and audited (`actor =
  scim:<token_id>`, rule 10). No new runtime dependency.
- **Trade-offs / accepted:** single primary-team membership (multi-group deferred);
  DELETE is a soft-deactivate, not a hard delete (documented, preserves FKs/audit);
  the PATCH reducer targets the real-world Okta/Entra op set, not the full RFC 7644
  path grammar. SCIM tokens are long-lived bearer secrets — hashed at rest, revocable,
  `last_used_at` stamped, but rotation is operator-driven.
- **Verification:** unit specs cover PATCH parsing + User mapping; the SCIM e2e
  (live Postgres) issues a token through the admin API and drives the full
  lifecycle — provision (`source=scim`), `userName` filter/`ListResponse`,
  duplicate→409, PATCH deactivation, malformed→400 SCIM error, Group→team
  membership, and cross-tenant 404 (a tenant-A token cannot read tenant-B users).
