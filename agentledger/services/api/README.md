# Control-plane API

NestJS + Prisma API over the Postgres control plane (tenants, identities, apps,
agents, virtual keys, policies, price book, budgets, allocation rules, connectors,
ROI templates, audit log). This is the TypeScript counterpart to the Go data plane.

This slice (Phase 3, task 1) is the **foundation + tenant-isolation spine**: the
service skeleton plus Postgres row-level security. AuthN/AuthZ, full CRUD,
analytics endpoints, OpenAPI/TS-client, and the dashboard land in later tasks.

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

## Endpoints

| Path          | Purpose                                            |
|---------------|----------------------------------------------------|
| `GET /healthz`| Liveness.                                          |
| `GET /readyz` | Readiness — pings Postgres.                        |
| `GET /metrics`| Prometheus text exposition.                        |
| `GET /v1/teams` | Teams visible to the current tenant (RLS-scoped). |

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTLEDGER_PG_DSN` | _(required)_ | Postgres DSN. Use the `agentledger_api` role (non-superuser) so RLS applies. |
| `AGENTLEDGER_API_ADDR` | `:8094` | Listen address (Go-style; the port is parsed out). |
| `AGENTLEDGER_API_BODY_LIMIT` | `256kb` | Max request body size. |
| `AGENTLEDGER_DEV_TRUST_HEADER` | _(unset)_ | **Dev only.** When `true`, the tenant is read from the `x-tenant-id` header. Replaced by JWT claims in task 2. |

## Test

```bash
npm test          # unit (infra-free)
npm run test:e2e  # cross-tenant RLS isolation — needs a live Postgres
# from repo root: `make e2e` brings Postgres up and runs the isolation suite.
```
