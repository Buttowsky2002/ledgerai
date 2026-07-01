# ADR-049 — Operator onboarding tooling (tenant CLIs, Integrations UI, SM secret backend)

**Date:** 2026-07-01
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** ADR-012 (tenant provisioning is CLI-only); ADR-033 (enterprise SSO + `resolveSecret` seam); ADR-034 (SCIM 2.0); CLAUDE.md rules 1, 3, 6, 9, 12

---

## Context

The SCIM/SSO protocol layers, auth guard, audit log, and Postgres schema were complete,
but the **operator tooling** to actually onboard a customer was missing: there was no
way to create a tenant, no self-serve surface for a customer admin to manage their own
SCIM tokens and IdP config, and adding an enterprise SSO customer required a redeploy to
inject their OIDC client secret as a new env var.

## Decision

1. **Tenant lifecycle CLIs** (`services/api/src/cli/create-tenant.ts`,
   `provision-tenant.ts`) mirroring the existing `delete-tenant.ts`: NestFactory
   application-context bootstrap, one structured JSON line on stdout, matching exit
   codes. Provisioning stays a CLI path only (ADR-012) — no REST endpoint, because it
   is cross-tenant and RLS-blocked.

   **RLS correctness (deviation from the naive approach):** the `tenants` table is
   `FORCE ROW LEVEL SECURITY` with `WITH CHECK (tenant_id = app_current_tenant())`
   (002_rls.sql) and the API connects as the non-BYPASSRLS `agentledger_api` role. A
   context-less `INSERT` into `tenants` would therefore be **rejected**. So the CLIs
   mint the tenant UUID client-side (`randomUUID()`) and run the whole create inside a
   single `withTenant(newId)` transaction — the tenant row and all children satisfy the
   check because their `tenant_id` equals the bound context.

2. **Dashboard Integrations tab** (`apps/dashboard/app/settings/page.tsx`): a customer
   admin can issue/revoke SCIM bearer tokens and add/remove OIDC IdP configs against the
   existing admin-only `/v1/scim-tokens` and `/v1/tenant-idp-config` endpoints. Server
   component fetches via the typed client; interactive forms are the only `"use client"`
   surface. `clientSecretRef` is captured as a **reference** (env-var / SM secret name),
   never the secret value.

3. **AWS Secrets Manager backend for `resolveSecret`** (`services/api/src/auth/secret-resolver.ts`):
   the sync env-only `resolveSecret` moved out of `oidc.config.ts` into an async resolver
   — env-var first (default; unchanged for existing deployments), then AWS Secrets Manager
   when `BADGERIQ_SM_ENABLED=true`. The `@aws-sdk/client-secrets-manager` SDK is
   **lazy-imported** so it only loads when SM is enabled, and results are cached in-process
   for 5 minutes (rule 12 — no unnecessary I/O; in-process, no Redis). This removes the
   redeploy-per-SSO-customer constraint at scale.

## Consequences

- **New dependency (rule 3):** `@aws-sdk/client-secrets-manager` in `services/api` only.
  Justification: the only maintained, first-party way to read AWS Secrets Manager;
  lazy-loaded so it is inert unless SM is opted in; no lighter alternative for the KMS/vault
  seam ADR-033 explicitly left open.
- **One caller changed:** `oidc.service.ts` now `await`s `resolveSecret` and wraps it in a
  `try/catch` that preserves the existing `400 BadRequest` on an unavailable secret (the new
  resolver throws instead of returning `undefined`).
- **Secret hygiene (rules 1, 6, 9):** the provision CLI's virtual-key plaintext appears only
  in stdout JSON — never persisted, never in audit `detail`. SCIM tokens and virtual keys
  remain SHA-256 hashes at rest, plaintext shown once.
- **No schema change:** `scim_tokens` and `tenant_idp_config` already exist (migrations 009/008).
- **Trade-off:** SM lookups are cached 5 min, so a rotated secret can take up to 5 minutes to
  take effect — acceptable for OIDC client secrets, which rotate rarely.

## Alternatives considered

- **REST tenant-provisioning endpoint** — rejected (ADR-012: cross-tenant, RLS-blocked).
- **Raw `$executeRaw` cross-tenant tenant INSERT** — rejected: fails closed under the
  `tenants` FORCE RLS `WITH CHECK`; the self-context single-transaction approach is correct.
- **App-side secret encryption** — rejected (ADR-033 precedent): no cipher exists in the
  codebase and inventing one violates dependency minimalism. SM is the managed backend.
