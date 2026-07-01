# Dashboard

Next.js 14 (App Router) FinOps dashboard for BadgerIQ. Pages are React Server Components
that call the control-plane API **server-side** through the generated typed client
(`@agentledger/shared-types`) — no token reaches the browser, no CORS.

Pages: Executive spend (`/`), Allocation (`/allocation`), Model mix (`/model-mix`), Budgets +
burn-down (`/budgets`), Risk events (`/risk`), Agent detail (`/agents/[id]`), and Settings
(`/settings` — virtual keys, policies, budgets CRUD). Analytics read from the ClickHouse MVs
via the API; settings writes go through Next route handlers (`app/api/*`) to keep them
server-side. Creating a virtual key shows the plaintext **once**.

## Auth

- **Dev**: set `BADGERIQ_DEV_TENANT_ID` (and run the API with
  `BADGERIQ_DEV_TRUST_HEADER=true`); the server client sends `x-tenant-id` so the dashboard
  renders real data without a live IdP.
- **Prod**: OIDC login (`/login`) redirects to the API; once a session `al_access` cookie is
  present it is sent as `Authorization: Bearer`. Live SSO needs provider client credentials.

## Run

```bash
# build the typed client first
cd ../../packages/shared-types && npm install && npm run build
# then the dashboard
cd ../../apps/dashboard && npm install
BADGERIQ_API_URL=http://localhost:8094 BADGERIQ_DEV_TENANT_ID=<tenant-uuid> npm run dev
# → http://localhost:3000
```

## Environment

Variables use the `BADGERIQ_*` prefix. The deprecated `LEDGERAI_*` and legacy
`AGENTLEDGER_*` names are still read as fallbacks so existing setups keep working.

| Variable | Default | Purpose |
|----------|---------|---------|
| `BADGERIQ_API_URL` | `http://localhost:8094` | Control-plane API base URL (server-side). |
| `BADGERIQ_DEV_TENANT_ID` | _(unset)_ | Dev only: tenant sent via `x-tenant-id`. |
