# ADR-014 — OpenAPI Spec + Generated TypeScript Client

**Date:** 2026-06-17
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 3 (CLAUDE_CODE_BUILD_SPEC.md §3 + target layout §2); ADR-010..013

---

## Context

The control-plane API (tasks 1–4) needs to be self-describing and typed for consumers: the
spec calls for an "OpenAPI spec generated; TS client into `packages/shared-types`", and the
target layout defines `packages/shared-types` as "generated TS types from OpenAPI + event JSON
Schema". The immediate consumer is the dashboard (task 6), which should not hand-maintain
request/response shapes.

---

## Decision

### Spec is generated from the code, not hand-written
`@nestjs/swagger` with its **CLI plugin** infers the OpenAPI document from the existing
controllers and `class-validator` DTOs — no manual `@ApiProperty` on every field. Because most
DTOs are declared inline in `*.controller.ts` (not separate `*.dto.ts`), the plugin's
`dtoFileNameSuffix` is set to `[".dto.ts", ".controller.ts"]` so their properties/required
flags are introspected. A `DocumentBuilder` adds title/version and a `bearer` (JWT) security
scheme, applied globally.

### Two ways to obtain the spec, one builder
`buildOpenApiDocument(app)` (`src/swagger.ts`) is shared by:
- **runtime** — `SwaggerModule.setup('docs', …)` serves Swagger UI at `/docs` and the JSON at
  `/docs-json` (raw middleware, outside the auth guards, so docs are reachable); and
- **build-time** — `cli/generate-openapi.ts` writes the canonical **`docs/api/openapi.json`**
  (committed = the published spec). It uses Nest **preview mode** (`{ preview: true }`), which
  builds the module graph for metadata scanning but instantiates **no providers/lifecycle** —
  so spec generation needs no Postgres, ClickHouse, or JWT secret. It runs after `nest build`
  so the plugin's compile-time metadata is present.

### Lightweight generated client
`packages/shared-types` (a standalone package — there is no npm workspace) generates:
- `src/openapi.ts` via **`openapi-typescript`** (typed paths/params/responses),
- `src/events.ts` via **`json-schema-to-typescript`** from `schemas/events/llm_call.schema.json`,
- `src/client.ts` — `createAgentLedgerClient({ baseUrl, token })` wrapping **`openapi-fetch`**.

Generated files are **committed** so consumers need no toolchain; `npm run generate` + `build`
refresh them. This stack is types-first with a tiny runtime — no Java/heavy codegen — matching
the repo's dependency-minimalism.

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| Hand-write the OpenAPI spec | Drifts from the code immediately; the plugin derives it for free. |
| Generate via a running server + HTTP scrape | Needs a live API + datastores; preview mode produces the same doc with zero infra. |
| `@hey-api/openapi-ts` / `openapi-generator` full SDK | Heavier, more opinionated output (and Java for openapi-generator); `openapi-typescript`+`openapi-fetch` is minimal and fully typed. |
| Put shared-types in an npm workspace | The repo has no workspace and is Go-centric; a standalone package with committed output is simpler. |

---

## Consequences

- **Positive**: One source of truth — the spec and client are derived from the same decorators
  the API already uses; the dashboard imports a fully-typed client (unknown paths/params are
  compile errors). Spec generation is infra-free and reproducible in CI.
- **Negative / scope**: Generated files are committed, so they must be regenerated when the API
  or event schema changes (a `make openapi` target + CI check can enforce freshness). The
  package isn't published to a registry yet — local consumers reference it directly.
- **Operational**: `/docs` + `/docs-json` are public (unauthenticated) so the spec is browsable;
  no secrets are in the spec (it documents env-var-named auth, not values).
