# ADR-031 — Non-human identity (NHI) credential governance

**Date:** 2026-06-20
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 6; ADR-027 (agent-native risk engine — deferred NHI credentials here); ADR-010 (RLS); ADR-012 (audit)

---

## Context

ADR-027 deferred **non-human identity governance**: short-lived, scoped
credentials per agent, an approval workflow, automatic decommissioning of dormant
agents, and a blast-radius view. Agents are first-class non-human identities
(the Postgres `agents` table already carries `approval_status`,
`decommissioned_at`, `data_access_scope`), but there was no credential lifecycle.

## Decision

A control-plane feature: Postgres table + a NestJS module, mirroring the P5
tool-governance pattern. No worker, no ClickHouse projection — this is pure
control plane (the *enforcement* of these credentials by the gateway is C4).

### Data model (migration 007 + Prisma)

`agent_credentials` (tenant FK + RLS `ENABLE`/`FORCE` + tenant-isolation policy +
grant to `agentledger_api`, exactly like 006). Lifecycle in one `status` column:
`pending` → `active` → `revoked`; `expired` is derived from `expires_at` at read
time. The secret is stored **only as a SHA-256 hash** (`token_hash`); the
plaintext is returned exactly once at issuance (security rule 6). `scopes` is a
least-privilege array; `approved_by`/`approved_at`, `revoked_at`/`revoked_reason`,
and `last_used_at` record the workflow and drive dormancy.

### API (`/v1/agent-credentials`)

- **issue** (`analyst`+): generate a one-time secret, store its hash, create
  `pending` with a TTL (default 24h). Returns `{credential, token}` — token once.
- **approve** (`admin`): `pending` → `active`; sets approver/time. Re-approving a
  non-pending credential is a 400.
- **revoke** (`admin`): → `revoked` with a reason.
- **list** (`viewer`): never returns `token_hash` (sanitized — defense in depth).
- **blast-radius** (`viewer`): per agent, active vs total credentials and
  allowlisted tool count, via an RLS-scoped raw query joining `agents`,
  `agent_credentials`, and `agent_tool_allowlist` (006).
- **decommission-dormant** (`admin`): a single data-modifying CTE revokes active
  credentials unused longer than `dormantDays` (default 30) and marks their agents
  `decommissioned_at`, then writes one audit row.

All CRUD runs through the existing `CrudService` (RLS via `withTenant`, audit in
the same transaction); a cross-tenant id is invisible under RLS and 404s.

### Why no field-encryption / KMS yet

Only a hash is stored, never a recoverable secret, so the KMS-backed
field-encryption path (rule 9) isn't needed here. If opaque credential *material*
is ever stored (e.g. for re-issuance), that gets its own encrypted column + ADR.

## Consequences

- Agents now have a governed credential lifecycle with approval, expiry, manual
  revocation, dormant auto-decommissioning, and a blast-radius view — all
  tenant-isolated and audited.
- OpenAPI + the typed client are regenerated with the new endpoints.
- Acceptance: an api e2e covers issue → approve → revoke, pending-only approval,
  role enforcement, cross-tenant RLS isolation, blast-radius, and dormant
  decommissioning (Postgres-backed).
- **Still deferred from ADR-027:** inline gateway enforcement of these credentials
  and the tool allowlist (C4, the last of the deferred-P5 seams). A blast-radius
  *dashboard* view can follow; the API endpoint already serves the data.
