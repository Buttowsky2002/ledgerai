# ADR-011 — Control-Plane Authentication (OIDC) + Session JWTs + RBAC

**Date:** 2026-06-17
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 3 (CLAUDE_CODE_BUILD_SPEC.md §3); security rules 6, 13; ADR-010 (RLS spine)

---

## Context

ADR-010 stood up `services/api` with tenant isolation enforced by Postgres RLS, but the
tenant was a **dev stand-in**: an `x-tenant-id` header behind `AGENTLEDGER_DEV_TRUST_HEADER`.
This ADR replaces that with real authentication and authorization, per the spec ("AuthN:
OIDC (Google/Microsoft), session JWTs. AuthZ: roles viewer/analyst/admin per tenant") and
security rule 6 ("session JWTs short-lived with refresh; rate-limit auth endpoints; tokens
stored as SHA-256 hashes only").

The critical continuity: the verified JWT becomes the **source** of the tenant id that the
ADR-010 chain (`runWithTenant → withTenant → set_config('app.tenant_id', …, true) → RLS`)
already consumes. The isolation mechanism is unchanged; only its input changes.

---

## Decision

### API role is a new axis on `identities` (migration 003)

The spec's API roles (`viewer | analyst | admin`) are an authorization tier and differ from
the existing `identities.role` (`member | admin | finance | security`), which is an
identity-graph/ownership concept and is left untouched. Migration 003 adds
`identities.api_role` (`CHECK IN ('viewer','analyst','admin')`, default `viewer`). One column,
already tenant-scoped because identities are one-per-tenant — so "role per tenant" is native.

### SSO email→identity uses a `SECURITY DEFINER` function — the only RLS bypass

At login no tenant is bound yet, so an RLS-protected `SELECT` on `identities` returns nothing.
Migration 003 adds `auth_lookup_identity(text)` — `SECURITY DEFINER`, `STABLE`,
`SET search_path = public`, exact-email match, `EXECUTE` revoked from `PUBLIC` and granted
only to `agentledger_api`. It returns just `(user_id, tenant_id, api_role)`. This is the
single sanctioned, narrowly-scoped RLS bypass; everything else stays subject to RLS. SSO
assumes one identity per email.

### Tokens: short access (bearer) + refresh (httpOnly cookie), stateless

`jose`-signed HS256 (secret from `AGENTLEDGER_JWT_SECRET`). Access token ~15 min, returned in
the response body and sent as `Authorization: Bearer` — not auto-sent by the browser, so API
calls aren't CSRF-exposed. Refresh token ~7 days in an **httpOnly Secure SameSite=strict**
cookie — unreadable by JS (XSS can't exfiltrate it), and only the `/auth/refresh` and
`/auth/logout` endpoints touch it. Verification pins issuer + audience + a distinct `typ`, so
a refresh token can't be replayed as an access token. **Stateless** (no sessions table this
task): logout clears the cookie; true server-side revocation is a documented follow-up
(pilot-acceptable, avoids an RLS-on-sessions design now).

### OIDC via `openid-client`, login transaction in a signed cookie

`openid-client` (a certified RP) gives one discovery-driven path for both Google and
Microsoft (Authorization Code + PKCE). Providers are configured from env (client id/secret by
**name**, per rule 1); a provider without credentials is simply unavailable. The login
`state`/`nonce`/PKCE `code_verifier` ride in a short-lived (~10 min) httpOnly JWT cookie, so
the callback validates them with no server-side session store.

### Auth in middleware, enforcement in guards

`AuthMiddleware` (replacing `tenant.middleware.ts`) verifies the access JWT and runs the
request inside the ADR-010 `AsyncLocalStorage` context — now `{ tenantId, userId, role }`.
Doing it in middleware (not a guard) is what lets the context wrap the whole pipeline,
exactly as ADR-010 needs for the RLS transaction. A global `AuthGuard` 401s any request with
no principal (except `@Public`: health, readyz, metrics, `/auth/login|callback|refresh|logout`);
`RolesGuard` + `@Roles()` enforce RBAC with `admin ⊇ analyst ⊇ viewer` min-rank semantics.
The dev `x-tenant-id` fallback is retained (binds a dev `admin` principal) so local dev and
the ADR-010 isolation suite keep working; it is inert unless `AGENTLEDGER_DEV_TRUST_HEADER=true`.
Auth endpoints are rate-limited via `@nestjs/throttler` (rule 6).

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| Map API role from existing `identities.role` | Conflates ownership roles with access tiers; the mapping is arbitrary. A dedicated `api_role` is explicit. |
| Access token in a cookie too | Cookies are auto-sent → CSRF surface on every API call. Bearer-in-header avoids it; only the long-lived refresh token needs cookie protection. |
| Server-side session store now | Enables revocation but adds a table + its own RLS subtlety (lookup before tenant is known). Deferred; stateless is pilot-adequate. |
| `passport` + strategies | Heavier; `openid-client` + a tiny guard is fewer moving parts and one code path for both IdPs. |
| Verify JWT in a guard, not middleware | A guard can't wrap the downstream in `AsyncLocalStorage.run`, which the RLS transaction depends on. |

---

## Consequences

- **Positive**: Real per-tenant auth feeding the proven RLS spine; isolation unchanged.
  RBAC enforced globally; only one auth-infra RLS bypass, tightly scoped and grant-restricted.
- **Positive**: XSS can't read the refresh token; bearer access avoids CSRF; auth endpoints
  rate-limited.
- **Negative / scope**: No server-side token revocation yet (logout is cookie-clear only);
  SCIM provisioning and auto-creation of identities are out of scope — unknown emails 401.
- **Operational**: Live Google/Microsoft login needs provider client id/secret env vars;
  without them those providers are unavailable. `AGENTLEDGER_JWT_SECRET` is required to boot.
  Verified in CI/tests with test-minted JWTs + a stubbed token exchange (no live IdP).
- **Verification note**: the ADR-010 isolation test's "no context" case now returns **401**
  (auth fails closed at the API edge), in addition to the DB-level RLS fail-closed.
