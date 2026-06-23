# Control-plane API

NestJS + Prisma API over the Postgres control plane (tenants, identities, apps,
agents, virtual keys, policies, price book, budgets, allocation rules, connectors,
ROI templates, audit log). This is the TypeScript counterpart to the Go data plane.

Tasks 1–5 are in: the **foundation + tenant-isolation spine** (RLS),
**authentication + RBAC** (OIDC login, session JWTs, viewer/analyst/admin roles),
**CRUD for all control-plane resources with an audit trail**, **read-only analytics over
the ClickHouse MVs**, and a **generated OpenAPI spec + typed TS client**. The dashboard lands
in the next task.

## OpenAPI / typed client

- Swagger UI: **`/docs`** · spec JSON: **`/docs-json`**. **Environment-gated:**
  served outside production by default; **not exposed in production** unless
  `LEDGERAI_EXPOSE_DOCS=true`, in which case production additionally requires a
  `LEDGERAI_DOCS_TOKEN` and the endpoints are gated behind
  `Authorization: Bearer <token>` (opting in without a token fails closed — docs
  stay off). A startup log line reports whether docs are enabled.
- Published spec: `docs/api/openapi.json` (committed). Regenerate with
  `npm run generate:openapi` (uses Nest preview mode — no DB needed).
- Typed client + types: `packages/shared-types` (`@agentledger/shared-types`) — generated from
  the spec (`openapi-typescript` + `openapi-fetch`) and the event schema
  (`json-schema-to-typescript`). From the repo root, `make openapi` refreshes both.

```
request ─▶ TenantMiddleware (binds tenant ctx) ─▶ handler
                                                    │
                              PrismaService.withTenant(tenantId, …)
                                                    │  set_config('app.tenant_id', …, true)
                                                    ▼
                                   Postgres (RLS enforces per-tenant rows)
```

## Tenant isolation (how it works)

- Every request runs its DB work inside a Prisma **interactive transaction** whose
  first statement binds `app.tenant_id` with `set_config(…, true)` — transaction-local,
  so it can never leak across Prisma's pooled connections.
- `deploy/postgres/002_rls.sql` enables `FORCE ROW LEVEL SECURITY` on all 11
  tenant-scoped tables; policies compare `tenant_id` to `app_current_tenant()`.
- The API connects as the **non-superuser** `agentledger_api` role, so it is always
  subject to RLS. No tenant bound ⇒ zero rows (fail closed).
- Handlers do **not** add `where: { tenantId }`; isolation is the database's job.
- See `docs/ADRs/010-control-plane-api-and-rls.md`.

## Run

```bash
# Local stack (Postgres migrations 001 + 002 auto-apply on first init):
docker compose up -d postgres api      # from repo root
curl -s localhost:8094/healthz

# Or run the API directly against a running Postgres:
cd services/api
npm ci
AGENTLEDGER_PG_DSN='postgres://agentledger_api:dev_only_change_me@localhost:5432/agentledger?sslmode=disable' \
AGENTLEDGER_DEV_TRUST_HEADER=true \
npm run start:dev
```

## Authentication & RBAC

```
GET /auth/login/:provider ─▶ OIDC provider ─▶ GET /auth/callback/:provider
   (state+nonce+PKCE in            (Google/MS)      │ verify id_token
    a signed httpOnly cookie)                       │ auth_lookup_identity(email)  ← SECURITY DEFINER
                                                    ▼
              access JWT (15m, body) + refresh JWT (7d, httpOnly cookie)
                                                    │
  request: Authorization: Bearer <access> ─▶ AuthMiddleware verifies → binds {tenantId,userId,role}
                                           ─▶ AuthGuard (401 if none) ─▶ RolesGuard (@Roles) ─▶ handler → RLS
```

- Access token: short-lived (~15m), sent as `Authorization: Bearer`. Refresh token: ~7 days,
  httpOnly Secure SameSite=strict cookie; `POST /auth/refresh` mints a new access token.
- API roles `viewer | analyst | admin` come from `identities.api_role` (migration 003),
  carried in the JWT and enforced by `@Roles()` (admin ⊇ analyst ⊇ viewer).
- Unknown SSO emails are rejected (no auto-provisioning). Live Google/Microsoft login needs
  provider client id/secret env vars; without them those providers are unavailable.

## Endpoints

| Path          | Auth | Purpose                                            |
|---------------|------|----------------------------------------------------|
| `GET /healthz`| public | Liveness.                                        |
| `GET /readyz` | public | Readiness — pings Postgres.                      |
| `GET /metrics`| public | Prometheus text exposition.                      |
| `GET /auth/login/:provider` | public | Start OIDC login (redirect to provider). |
| `GET /auth/callback/:provider` | public | OIDC callback → issues tokens.        |
| `POST /auth/refresh` | refresh cookie | Mint a fresh access token.              |
| `POST /auth/logout` | public | Clear the refresh cookie.                        |
| `GET /auth/me` | bearer | Current principal.                                |

## Resources (CRUD)

All under `/v1/`, tenant-scoped by RLS, **reads require `viewer`, writes require `admin`**,
and **every create/update/delete writes an `audit_log` row** (`actor`/`action`/`object`/
`{before,after}`, in the same transaction as the change). Standard verbs per resource:
`GET` (list, `?limit`/`?offset` — default 50, max 100), `GET /:id`, `POST`, `PATCH /:id`,
`DELETE /:id`. A foreign-tenant id returns 404 (RLS).

| Resource | Path | Notes |
|----------|------|-------|
| Teams | `/v1/teams` | |
| Identities | `/v1/identities` | `api_role` here drives RBAC. |
| Apps | `/v1/apps` | |
| Agents | `/v1/agents` | |
| Policies | `/v1/policies` | DLP/budget/model_allow/approval. |
| Budgets | `/v1/budgets` | |
| Allocation rules | `/v1/allocation-rules` | |
| Virtual keys | `/v1/virtual-keys` | `POST` returns the plaintext `alk_…` **once**; only the SHA-256 hash is stored; `DELETE` = revoke. |
| Price book | `/v1/price-book` | **Global** (no tenant); reads viewer, writes admin. |
| Tenant | `/v1/tenant` | `GET`/`PATCH` the caller's **own** tenant (no create/delete). |

## Analytics (read-only)

`GET /v1/analytics/*`, `viewer`+, served from **ClickHouse materialized views only** (never
raw `llm_calls`). Tenant isolation is enforced by a `tenant_id` filter **bound from the JWT**
(ClickHouse has no RLS); all inputs are parameterized. Date ranges via `?from`/`?to` (ISO,
default last 30 days).

| Path | View | Backs |
|------|------|-------|
| `/analytics/spend` | `spend_daily` | Executive spend (daily series). |
| `/analytics/allocation?dimension=team\|app\|agent` | `spend_daily` / `spend_hourly_by_key` | Allocation. |
| `/analytics/model-mix` | `spend_daily` | Model mix. |
| `/analytics/burndown?virtualKeyId=` | `spend_hourly_by_key` | Budget burn-down (hourly + cumulative). |
| `/analytics/risk` | `risk_daily` | Risk events. |
| `/analytics/unit-economics?outcomeType=` | `v_unit_economics` | Cost per outcome. |
| `/analytics/agents/:agentId` | `spend_hourly_by_key` + `agent_runs` | Agent detail. |

## Outcome Graph (runs, outcomes, agent ROI)

The cost→outcome evidence chain (ADR-046), all tenant-scoped via the JWT-bound
`tenant_id` filter (ClickHouse has no RLS); all inputs parameterized.

| Path | Method | Role | Backs |
|------|--------|------|-------|
| `/v1/agents/:id/roi?from=&to=` | GET | `viewer` | `v_roi` + `v_agent_daily_unit_economics` — per-agent cost/value/net/cost-per-success/risk-adjusted ROI + daily series. |
| `/v1/runs/:id` | GET | `viewer` | `agent_runs` + `outcomes` + `agent_tool_calls` — single run with its outcomes and tool calls (the run node of the evidence chain); 404 if absent. |
| `/v1/outcomes?outcomeType=&source=&agentId=&minConfidence=&from=&to=` | GET | `viewer` | `outcomes` ⋈ `agent_runs` — outcomes with their run's AI cost. |
| `/v1/outcomes` | POST | `analyst` | Creates one outcome directly in ClickHouse (`source='api'`), audited. Body: `{ outcomeType, valueUsd, runId?, userId?, teamId?, source?, confidence?, occurredAt?, completionStatus?, qualityScore? }`. `tenant_id` is stamped from the principal; no content field (rules 2/3). |

The per-agent daily rollup view `v_agent_daily_unit_economics` (ClickHouse migration
010) aggregates `v_roi` to `(tenant_id, agent_id, day)`: `cost_usd`, `outcomes_count`,
`value_usd`, `net_value_usd`, `cost_per_success`, `attribution_confidence_avg`,
`risk_adjusted_roi`.

## LARI — Risk-Adjusted Incremental ROI

`GET /v1/agents/:id/lari?from=&to=`, `viewer`+ (ADR-047). An explainable,
**deterministic** per-agent ROI: it nets incrementality, fully-loaded cost,
expected risk loss, and an evidence-uncertainty reserve, scores confidence, and
recommends an action — with an audit ledger behind every figure.

```
LARI = ( AttributedIncrementalValue
         − FullyLoadedAgentCost
         − ExpectedRiskLoss
         − UncertaintyReserve )
       / max(FullyLoadedAgentCost, epsilon)
```

- **AttributedIncrementalValue** = Σ grossValue × attributionConfidence × incrementalityFactor (both ∈ [0,1], so manual/low-confidence outcomes are discounted).
- **FullyLoadedAgentCost** = token + human review + infra + amortized build.
- **ExpectedRiskLoss** = valueAtRisk × incidentProbability (more risk ⇒ lower ROI).
- **UncertaintyReserve** = positiveValue × (1 − confidence/100) × factor (weak evidence ⇒ lower ROI).
- **epsilon** floors the denominator so zero cost never divides by zero.

**ConfidenceScore** (0–100) = 100 × (0.25·evidenceQuality + 0.20·attributionStrength + 0.20·causalStrength + 0.15·costCompleteness + 0.10·outcomeVerification + 0.10·recency).

**Recommendation** ∈ `scale` · `maintain` · `optimize` · `improve_evidence` · `require_approval` · `investigate` · `pause` · `retire` (critical risk gates first → require_approval / pause; then negative ROI → retire / investigate; then low confidence → improve_evidence; then scale / optimize / maintain).

The engine (`src/lari/`) is pure and framework-free — **no LLM ever decides a
financial figure, and no raw prompt/response content is required** (rules 2/7/8).
The endpoint's `LariService` assembles the input from `v_roi` (value + loaded
costs + confidence), `spend_hourly_by_key` (token spend), `risk_events`
(severity), `outcomes` (provenance), and Postgres `attribution_edges` (the
counterfactual delta) — all tenant-scoped. Every result echoes an evidence ledger
(value/cost/risk drivers, confidence factors, attribution reasons, baseline
method, limitations).

## Import (bulk backfill)

`POST /v1/import/events`, **`admin` only** (ADR-045). Backfills historical/offline
activity into the canonical ClickHouse tables (`llm_calls` / `outcomes` /
`agent_tool_calls` / `risk_events`). Body: `{ "events": [ <row>, … ], "dryRun"?: bool }`
(batch capped at 1000 rows; chunk larger imports). Each flat row may carry usage,
an outcome, a tool call, and/or a risk signal — every present signal becomes its
own event. Per **rule 2** rows carry no content, only cost/usage/attribution
dimensions.

- **Idempotent:** a row with an `idempotency_key` is recorded in the tenant-scoped
  `import_idempotency` table; re-importing a seen key is **skipped** (no double
  counting). Keys repeated within a batch collapse to one. Rows without a key are
  always imported.
- **All-or-nothing:** one invalid row → `400` with the offending line numbers;
  nothing is written.
- **Tenant-stamped:** `tenant_id` comes from the JWT principal, never request input.
- `dryRun: true` validates and reports the plan (`{received, imported, skipped,
  events, byTable}`) without writing. Each applied import writes an `audit_log` row.

Supported row fields: `idempotency_key`, `timestamp`, `team_id`, `user_id`,
`agent_id`, `run_id`, `provider`, `model`, `input_tokens`, `output_tokens`,
`cost_usd`, `tool_name`, `outcome_type`, `outcome_value_usd`,
`attribution_confidence`, `risk_severity` (`low|medium|high|critical`).

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTLEDGER_PG_DSN` | _(required)_ | Postgres DSN. Use the `agentledger_api` role (non-superuser) so RLS applies. |
| `AGENTLEDGER_CLICKHOUSE_URL` / `_DB` / `_USER` / `_PASSWORD` | `http://localhost:8123` / `agentledger` / `default` / _(empty)_ | ClickHouse connection for analytics. |
| `AGENTLEDGER_API_ADDR` | `:8094` | Listen address (Go-style; the port is parsed out). |
| `AGENTLEDGER_API_BODY_LIMIT` | `256kb` | Max request body size. |
| `AGENTLEDGER_JWT_SECRET` | _(required)_ | HS256 signing secret for session JWTs. |
| `AGENTLEDGER_JWT_ACCESS_TTL` | `15m` | Access-token lifetime. |
| `AGENTLEDGER_JWT_REFRESH_TTL` | `7d` | Refresh-token lifetime. |
| `AGENTLEDGER_OIDC_REDIRECT_BASE` | `http://localhost:8094` | Base URL for OIDC callback redirect URIs. |
| `AGENTLEDGER_OIDC_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET` | _(unset)_ | Google OIDC client; unset → provider unavailable. |
| `AGENTLEDGER_OIDC_MICROSOFT_CLIENT_ID` / `_CLIENT_SECRET` | _(unset)_ | Microsoft OIDC client; unset → provider unavailable. |
| `AGENTLEDGER_DEV_TRUST_HEADER` | _(unset)_ | **Dev only.** When `true`, an `x-tenant-id` header (no Bearer) binds a dev `admin` principal. |
| `LEDGERAI_EXPOSE_DOCS` | _(unset)_ | Expose `/docs` + `/docs-json`. Auto-on outside production; in production set `true` to opt in (then a token is required). |
| `LEDGERAI_DOCS_TOKEN` | _(unset)_ | Bearer token required to view docs **in production**. Without it, a production opt-in fails closed (docs stay off). |

## Test

```bash
npm test          # unit (infra-free)
npm run test:e2e  # cross-tenant RLS isolation — needs a live Postgres
# from repo root: `make e2e` brings Postgres up and runs the isolation suite.
```
