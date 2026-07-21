# Deployment & packaging

LedgerAI runs in three modes. Pick by what you need:

| Mode | Use it for | Provider keys? | Auth |
|------|-----------|----------------|------|
| **Demo** | See the dashboard with seeded data | **No** | Dev (header) |
| **Gateway dev** | Try the gateway inline path locally | Optional | Dev |
| **Production / self-host** | Run it for real | Yes (your providers) | OIDC + tokens |

Full variable reference: [`ENVIRONMENT.md`](ENVIRONMENT.md). Example env file:
[`.env.example`](../.env.example).

---

## 1. Demo mode

Goal: a new user sees the product end to end **without any provider keys**.

```bash
make demo
```

This brings up Postgres + ClickHouse + the API (via `docker compose`), seeds a demo
tenant with synthetic, content-free activity (`make seed-demo`), and prints the
dashboard command. Then start the dashboard:

```bash
(cd packages/shared-types && npm ci && npm run build)
(cd apps/dashboard && npm ci && \
   LEDGERAI_API_URL=http://localhost:8094 \
   LEDGERAI_DEV_TENANT_ID=00000000-0000-4000-8000-000000000001 \
   LEDGERAI_DEMO_MODE=true \
   npm run dev)
# → http://localhost:3000  (a "Demo mode" banner confirms seeded data)
```

The seed creates one tenant with 4 teams and **8 named agents** (1,000 LLM calls,
50 runs, 30 outcomes, 150 tool calls, 12 risk events, 5 budgets) engineered to
tell a coherent story:

- **InvoiceReviewAgent** (Finance) — strong ROI: lean cost, high-value outcomes.
- **DataCleanupAgent** (Security) — runaway cost: dominates spend, no outcomes.
- **SOC-TriageAgent** (Security) — high risk: blocked/redacted calls + risk events.

`LEDGERAI_DEMO_MODE=true` shows the dashboard demo banner. Clear the demo data
with `make reset-demo` (or `docker compose down -v` for a full reset).

- **No provider keys**: the demo injects pre-aggregated analytics directly into
  ClickHouse, so nothing calls a model provider.
- **Auth**: the API runs with the dev trust-header bypass (`x-tenant-id` →
  dev admin). The dashboard sends the demo tenant id as that header. This is
  **dev only** and is impossible in production (see below).
- **Re-seed** anytime with `make seed-demo` (idempotent). Reset fully with
  `docker compose down -v`.

The demo tenant id is a real UUID (`00000000-0000-4000-8000-000000000001`) because
the API validates the dev `x-tenant-id` header as a UUID.

### Design partner onboarding (live tenant + LARI)

When presenting to design partners on a **live tenant** (real connector spend, no full
demo reset), use the one-shot onboard API to register agents, seed bootstrap
runs/outcomes, trigger attribution V2, and verify LARI — without touching existing
`llm_calls`.

**Prerequisites:** `docker compose` stack up with `BADGERIQ_DESIGN_PARTNER_ONBOARD_ENABLED=true`
and `BADGERIQ_ATTR_ALLOW_TRIGGER=true` (set in the dev compose file).

```bash
curl -X POST http://localhost:8094/v1/design-partner/onboard \
  -H "x-tenant-id: YOUR-TENANT-UUID" \
  -H "Content-Type: application/json" \
  -d '{"preset":"studio-live"}'
```

Or use the Make wrapper (calls the same API):

```bash
make bootstrap-graph
# BADGERIQ_DEV_TENANT_ID=<uuid> powershell -File deploy/demo/bootstrap-outcome-graph.ps1
```

**Built-in presets:** `studio-live` — three agents (CodeReview, InvoiceReview,
SupportBot) with SDK-stamped runs and matching outcomes in the Apr–Jun 2026 CFO window.

The response includes stamped-outcome counts, `v_roi` row counts, per-agent LARI
summaries, and the recommended dashboard date range. List presets with
`GET /v1/design-partner/presets` (admin role).

### Purge Acme artifacts from pilot (keep real SSO users)

Use this when the well-known demo tenant
(`00000000-0000-4000-8000-000000000001`, formerly **Acme Demo Co**) was seeded
into AWS but you still need real Studio Designer / SSO identities and connectors
on that same tenant. Do **not** drop the tenant row.

1. **Postgres** — apply migration `028_purge_acme_demo_artifacts.sql` (deletes
   `@acme.test` identities, the eight demo agents + their agent budgets, renames
   the tenant to **Studio Designer**):

   ```bash
   ./deploy/terraform/scripts/migrate.sh --env pilot --target postgres
   ```

2. **ClickHouse** — purge synthetic analytics (`demo-user-*`, demo agent names,
   `vk_demo_*` / `demo_call_*`, demo `app_id` rollups):

   ```bash
   bash deploy/ops/purge-acme-demo-clickhouse.sh --env pilot
   # local compose: bash deploy/ops/purge-acme-demo-clickhouse.sh
   ```

3. **Confirm:**

   ```sql
   -- Postgres
   SELECT email FROM identities WHERE email LIKE '%@acme.test';  -- 0 rows
   SELECT name FROM tenants
     WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
   -- expect: Studio Designer (not Acme Demo Co)

   -- ClickHouse
   SELECT count() FROM agentledger.llm_calls
     WHERE startsWith(user_id, 'demo-user-');  -- 0
   ```

Local `make demo` / `deploy/demo/*` remain for evaluation stacks only.
`BADGERIQ_DEMO_MODE` stays `false` in Terraform for pilot/prod.

---

## 2. Gateway dev mode

Goal: exercise the gateway's inline path (auth → DLP → budget reserve → proxy →
usage/cost → event) locally.

**Smoke test against a built-in mock upstream (no real key):**

```bash
make smoke   # runs services/gateway/smoke_test.py — mock provider, asserts the full path
```

**Against a real provider:** put a key in `.env` (`OPENAI_API_KEY=...`), bring up
the gateway, and call it like OpenAI:

```bash
cp .env.example .env   # then set OPENAI_API_KEY
docker compose up -d gateway clickhouse redis
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer <your-virtual-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

Virtual keys / policies for local runs come from
`services/gateway/config.example.json`. Ops endpoints (`/v1/usage`, `/metrics`) are
localhost-only in dev unless you set an ops token (see production).

---

## 3. Production / self-host mode

Goal: run LedgerAI safely for real workloads. Deploy the app workloads with the
Helm chart (`deploy/helm/agentledger`) against **externally-managed** Postgres,
ClickHouse, Redpanda/Kafka, and Redis (the chart bundles no databases).

### Secrets (required — inject via your secret manager, never a committed file)

| Secret | Used by | Notes |
|--------|---------|-------|
| `LEDGERAI_JWT_SECRET` | API | HS256 session-token secret. `openssl rand -hex 32`. |
| `LEDGERAI_PG_DSN` | API, workers, connectors, gateway (PG reload) | Use the **non-superuser** `agentledger_api` role so RLS applies; `sslmode=require`. |
| `LEDGERAI_CLICKHOUSE_PASSWORD` | API, workers, connectors | ClickHouse auth. |
| `LEDGERAI_OPS_TOKEN` | gateway | Bearer for `/v1/usage` + `/metrics`. |
| `LEDGERAI_DOCS_TOKEN` | API | Bearer for Swagger if docs are exposed. |
| Provider keys (`OPENAI_API_KEY`, …) | gateway | Referenced by **name** in gateway config; never inline. |
| OIDC client secrets | API | Referenced by env-var **name**; per-tenant SSO via SCIM/OIDC. |

### Auth — do NOT use dev auth in production

- **Never set `LEDGERAI_DEV_TRUST_HEADER`** (the `x-tenant-id` bypass). The API
  **refuses to start** in production (`NODE_ENV=production`) if it is enabled, and
  the dashboard never sends `x-tenant-id` in production builds. Authenticate users
  via **OIDC SSO** (`/auth/sso/login`) with session JWTs.
- Set `NODE_ENV=production` for the API.

### Ops endpoints & docs

- Protect the gateway's `/v1/usage` and `/metrics` with `LEDGERAI_OPS_TOKEN`
  (`Authorization: Bearer …`). With no token in production they return 404.
  Expose `/metrics` to a private scrape network only (`LEDGERAI_METRICS_PUBLIC=true`
  if and only if the scrape network is trusted).
- Swagger docs are **off in production** unless `LEDGERAI_EXPOSE_DOCS=true`, and
  then require `LEDGERAI_DOCS_TOKEN`.

### Migrations (forward-only, numbered)

Apply before/with each release. They are **not** auto-run in production.

- **Postgres** — `deploy/postgres/0NN_*.sql` in order. The compose demo applies
  them via `initdb`; in production run them with your migration tooling
  (`psql -f`), then grant the `agentledger_api` role `LOGIN` + a password via your
  secret manager (the dev `pg-dev-init` helper is **dev only**).
- **ClickHouse** — `deploy/clickhouse/0NN_*.sql` in order (creates `llm_calls`,
  the materialized views, graph/ROI/risk tables).

Never edit an applied migration; add a new numbered file.

### Backup & retention

- **Postgres** (control plane: tenants, keys-as-hashes, policies, audit log) is the
  source of truth — take regular `pg_dump`/PITR backups and test restores. The
  `audit_log` table is your tamper-evidence trail; retain per your compliance needs.
- **ClickHouse** (analytics) — `llm_calls` is TTL-tiered to a `cold` volume at
  **13 months** then dropped (`001_events.sql`); budget keys in Redis expire ~7
  days after month-end (reconciliation window). Back up ClickHouse with
  `BACKUP`/object-storage snapshots if you need history beyond the TTL; the
  materialized-view aggregates can be rebuilt from `llm_calls` while it is retained.
- **Secrets**: virtual keys are stored only as SHA-256 hashes (plaintext shown once
  at creation) — they cannot be recovered from a backup; re-issue if lost.
- **Tenant deletion** (GDPR-style erase): `make delete-tenant TENANT=<uuid>`
  cascades Postgres rows and `ALTER … DELETE`s ClickHouse — itself an audited event.

### Verify a deployment

```bash
curl -fsS https://<api-host>/healthz        # API liveness
curl -fsS https://<api-host>/readyz         # API readiness (pings Postgres)
curl -fsS -H "Authorization: Bearer $LEDGERAI_OPS_TOKEN" https://<gw-host>/metrics
```
