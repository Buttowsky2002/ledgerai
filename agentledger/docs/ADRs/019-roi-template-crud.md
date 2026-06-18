# ADR-019 — ROI Template CRUD + Editor

**Date:** 2026-06-18
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 4 (CLAUDE_CODE_BUILD_SPEC.md §3); ADR-010 (control-plane API + RLS); ADR-012 (CRUD resources + audit); ADR-018 (attribution matcher)

---

## Context

The ROI engine converts business outcomes into dollars via **ROI templates**: per-tenant rules
(`value_formula` + `attribution`) keyed by `outcome_type`/`source_system`. The `roi_templates`
table, its RLS policies (own-tenant rows + read-only built-in packs where `tenant_id IS NULL`),
the API role grants, and the Prisma `RoiTemplate` model already shipped with Phase 3. Phase 4
task 4 adds the missing management surface: a CRUD API resource and a dashboard editor, then
regenerates the published OpenAPI spec + shared TS types.

## Decision

### Reuse the generic CRUD/RLS/audit path

`RoiTemplatesController` wraps the shared `CrudService` (`common/crud.service.ts`) exactly like
`BudgetsController`: every op runs inside `prisma.withTenant(...)` (RLS confines it to the
caller's tenant — no `where: { tenantId }`), `tenant_id` is injected on create, and an
`audit_log` row is written in the same transaction. Reads are `@Roles('viewer')`, writes
`@Roles('admin')`. No DB migration — the table, RLS, grants, and Prisma model already exist.
Built-in packs (`tenant_id IS NULL`) remain readable but, per the RLS `WITH CHECK`, unwritable
by tenants; the editor hides their delete control.

### Validate the JSONB shapes (chosen)

`value_formula` and `attribution` are validated with nested class-validator DTOs
(`@ValidateNested` + `class-transformer` `@Type`): `ValueFormulaDto {hourly_rate, baseline_minutes,
rework_pct?}` and `AttributionDto {window_minutes?, match_on?:[branch|user|issue]}`.
`outcome_type`/`source_system` are constrained with `@IsIn` to the connector/outcome enums. With
the global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`), malformed templates are
rejected with 400 rather than persisted as free-form JSON.

*Rejected:* accepting arbitrary `@IsObject()` blobs — less code but lets bad templates reach the
value-application step (task 5), where they'd fail opaquely.

### Structured dashboard editor (chosen)

The `/roi-templates` page mirrors `app/budgets/page.tsx` (server component + typed
`apiClient()`); the create form uses **structured fields** (number inputs + `match_on`
checkboxes) that assemble the JSON objects on submit, posting through the existing BFF route
handlers (`app/api/roi-templates/**`, cookie-auth proxy). *Rejected:* raw-JSON textareas — less
code but error-prone and a worse "editor".

## Consequences

- **Positive**: a full CRUD + editor with tenant isolation, audit, and RBAC inherited from the
  Phase-3 plumbing; only a controller + module + DTOs + a dashboard page/form were added. The
  regenerated `docs/api/openapi.json` + `@agentledger/shared-types` keep the typed client honest.
- **Negative / scope**: `value_formula` is captured but **not yet applied** — writing
  `business_value_usd` onto outcomes from the formula is task 5 / the seeded demo. The Jira JQL-
  style `match_on` overrides are stored but the attribution matcher (ADR-018) still uses env
  defaults until it's wired to read `roi_templates` (a later step). UI role-gating is unchanged
  (the API enforces `@Roles('admin')`; the dashboard has no client-side gating yet).
- **Operational**: after any API resource change, regenerate with the `make openapi` equivalent —
  `services/api: npm run generate:openapi` then `packages/shared-types: npm run generate && npm run build` —
  and commit the spec + types with the change (CLAUDE.md).
