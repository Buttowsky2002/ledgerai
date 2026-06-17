# Control-plane API

NestJS + Prisma API over the Postgres control plane (tenants, identities, apps,
agents, virtual keys, policies, price book, budgets, allocation rules, connectors,
ROI templates, audit log). This is the TypeScript counterpart to the Go data plane.

Tasks 1–3 are in: the **foundation + tenant-isolation spine** (RLS),
**authentication + RBAC** (OIDC login, session JWTs, viewer/analyst/admin roles), and
**CRUD for all control-plane resources with an audit trail**. Analytics endpoints,
OpenAPI/TS-client, and the dashboard land in later tasks.

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

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTLEDGER_PG_DSN` | _(required)_ | Postgres DSN. Use the `agentledger_api` role (non-superuser) so RLS applies. |
| `AGENTLEDGER_API_ADDR` | `:8094` | Listen address (Go-style; the port is parsed out). |
| `AGENTLEDGER_API_BODY_LIMIT` | `256kb` | Max request body size. |
| `AGENTLEDGER_JWT_SECRET` | _(required)_ | HS256 signing secret for session JWTs. |
| `AGENTLEDGER_JWT_ACCESS_TTL` | `15m` | Access-token lifetime. |
| `AGENTLEDGER_JWT_REFRESH_TTL` | `7d` | Refresh-token lifetime. |
| `AGENTLEDGER_OIDC_REDIRECT_BASE` | `http://localhost:8094` | Base URL for OIDC callback redirect URIs. |
| `AGENTLEDGER_OIDC_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET` | _(unset)_ | Google OIDC client; unset → provider unavailable. |
| `AGENTLEDGER_OIDC_MICROSOFT_CLIENT_ID` / `_CLIENT_SECRET` | _(unset)_ | Microsoft OIDC client; unset → provider unavailable. |
| `AGENTLEDGER_DEV_TRUST_HEADER` | _(unset)_ | **Dev only.** When `true`, an `x-tenant-id` header (no Bearer) binds a dev `admin` principal. |

## Test

```bash
npm test          # unit (infra-free)
npm run test:e2e  # cross-tenant RLS isolation — needs a live Postgres
# from repo root: `make e2e` brings Postgres up and runs the isolation suite.
```
