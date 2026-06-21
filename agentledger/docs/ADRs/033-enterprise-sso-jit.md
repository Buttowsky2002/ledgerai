# ADR-033 — Enterprise SSO (per-tenant OIDC) + JIT provisioning

**Date:** 2026-06-21
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 6 (CLAUDE.md — SSO/SCIM); ADR-011 (auth: OIDC/JWT/RBAC — this lifts its explicit "no per-tenant IdP, no auto-provisioning" deferral); ADR-010 (control plane + RLS). Paired with ADR-034 (SCIM provisioning), which consumes this migration's identity columns.

---

## Context

Auth today (ADR-011) is a **single global** Google/Microsoft OIDC app: a user
signs in, their verified email is looked up in `identities`, and an unknown email
is **rejected** (`auth_lookup_identity`, no provisioning). Enterprises — the
CISO/FinOps buyer — bring their **own** IdP (Okta/Entra/…) and expect their
workforce to sign in through it, with accounts created on first login and removed
when the IdP says so. ADR-011 deferred exactly this. P6-D1 delivers the SSO half
(D2/ADR-034 delivers SCIM deprovisioning); scope is **OIDC only — no SAML** (the
stack is already OIDC; SAML would add a heavyweight dependency for no buyer we
have today).

## Decision

### Per-tenant OIDC IdP, resolved by email domain

`tenant_idp_config` (migration 008) holds one OIDC IdP per tenant: `issuer`,
`client_id`, a `client_secret_ref`, and the `email_domains` that route to it. At
`GET /auth/sso/login?email=…` the gateway extracts the domain, resolves the IdP,
and redirects (Authorization Code + PKCE). The signed `oidc_tx` cookie now also
carries `tenantId`+`idpId`, so `GET /auth/sso/callback` finishes statelessly and
on any replica (it re-reads the IdP by id under the trusted tenant from the
cookie). `openid-client` is reused unchanged; per-tenant `Client`s are discovered
lazily and cached by `idp_id`. The global Google/Microsoft flow is untouched.

**Secrets:** `client_secret_ref` is a *reference* (env-var name / KMS-vault key),
never the secret (rules 1 + 9) — the same `secret_ref` convention as
`connectors.secret_ref` and the gateway's `api_key_env`. `resolveSecret(ref)`
reads it (env today; a KMS backend slots in without touching callers). **No
app-side encryption layer was introduced** — none exists in the codebase and
inventing one would violate the dependency-minimalism bias.

### JIT provisioning + soft-deactivation

`identities` gains `external_id` (the IdP subject `sub`) and `active` (soft
delete). On a verified SSO callback:

- existing + `active` → mint tokens (existing path);
- existing + `active = false` → **401** (deactivated);
- absent + the IdP's `jit_enabled` → **provision** a new identity (`source` =
  classified from the issuer: `okta`/`entra`/`oidc`; `external_id` = `sub`;
  `api_role` = the IdP's `default_api_role`) → mint tokens;
- absent + JIT disabled → 401.

Login runs before any tenant is bound, so three **SECURITY DEFINER** functions
(the only sanctioned RLS bypass, mirroring `auth_lookup_identity`) do the work:
`idp_lookup_by_domain`, `auth_lookup_identity_in_tenant` (tenant-scoped because
the same email may now exist in multiple tenants), and `auth_provision_identity`
(`INSERT … ON CONFLICT DO NOTHING` — a provisioning race re-reads rather than
errors). `auth_lookup_identity` itself is updated (same signature) to filter
`active = true`, so the global flow also refuses deactivated users.

JIT provisioning is audited (rule 10): there is no request principal at login, so
the `audit_log` row is written inside an explicit `withTenant(tenantId, …)`
transaction (sets `app.tenant_id` → RLS `WITH CHECK` passes) with `actor =
sso:<provider>`.

### Admin surface

`/v1/tenant-idp-config` is admin-only (`@Roles('admin')`) CRUD via the generic
`CrudService` (RLS + audit), so a tenant admin registers/rotates their IdP. DTOs
reject unknown fields (rule 5, global ValidationPipe); domains are stored
lowercased/de-duplicated to match the case-insensitive login lookup.

## Consequences

- **Positive:** enterprises self-serve BYO-IdP SSO with automatic onboarding; the
  pre-wired `identities.source`/`aliases` seam is finally used; `external_id` +
  `active` are the foundation SCIM (ADR-034) deprovisions against. No new runtime
  dependency; per-tenant client discovery is cached so login adds no steady-state
  I/O beyond the identity lookup.
- **Trade-offs / accepted:** OIDC only (SAML deferred until a customer needs it).
  `client_secret_ref` resolves to env today — multi-tenant secret management at
  scale wants a real KMS/vault backend behind `resolveSecret`, deliberately left
  as a drop-in seam. The same email may now exist across tenants; all SSO lookups
  are therefore tenant-scoped (the global `auth_lookup_identity` keeps its
  one-identity-per-email assumption for the legacy Google/MS path only).
- **Verification:** unit suite covers the provisioning state machine
  (active/inactive/JIT-on/JIT-off/race); the SSO e2e (live Postgres, `OidcService`
  stubbed) proves first-login JIT, no-duplicate re-login, deactivation-blocks-login,
  unknown-domain 401, and cross-tenant domain isolation.
