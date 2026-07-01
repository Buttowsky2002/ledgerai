# Operator runbook — onboarding a new customer

Practical steps to take a customer from zero to logged-in and (optionally) SSO/SCIM.
Tenant provisioning is a **CLI operation** (ADR-012: cross-tenant + RLS-blocked, so
there is deliberately no REST endpoint). The CLIs run against the same Postgres the
API uses and connect as the RLS-enforced `agentledger_api` role.

> The CLIs run compiled JS (`node dist/cli/*.js`), so build once before first use.
> Env-var names accept the `BADGERIQ_*` prefix (with `LEDGERAI_*` / `AGENTLEDGER_*`
> aliases). `BADGERIQ_PG_DSN` must point at the target Postgres.

## 1. Provision the tenant (~2 minutes)

```bash
cd agentledger/services/api
npm run build            # first time only (produces dist/cli/*.js)
npm run provision-tenant -- \
  --name "Customer Name" \
  --admin-email "admin@customer.com" \
  --plan team
```

This creates the tenant, a `Default` team, the first admin identity, and the first
virtual key in one transaction. Copy the `virtual_key` from the stdout JSON — **it is
shown once only.** Send it to the customer's technical contact over a secure channel.

To create just the tenant shell (no admin/key), use `npm run create-tenant -- --name … --plan …`.

## 2. Onboard the admin user

The admin logs in at `https://app.yourdomain.com/auth/login/google` (or your configured
global OIDC provider) with the email you provisioned above. Their account already
exists; they land on the dashboard. Until they issue a virtual key the dashboard shows
a first-run onboarding banner linking to Settings.

## 3. Customer configures SSO (optional, enterprise customers)

The admin goes to **Settings → Integrations → SSO / identity provider** and adds their IdP:

- Set OIDC **issuer**, **client ID**, and the **env-var name** that holds their client secret
  (`clientSecretRef` — a reference, never the secret itself).
- Set the **email domains** that should route to this IdP.
- Set the callback URL in their IdP to: `https://app.yourdomain.com/auth/sso/callback`
- Provide the secret to the API container and roll it:

```bash
kubectl -n agentledger \
  patch secret agentledger-secrets \
  --patch='{"stringData":{"CUSTOMER_OIDC_SECRET":"<value>"}}'
kubectl rollout restart deployment/agentledger-api -n agentledger
```

Or set `AGENTLEDGER_SM_ENABLED=true` and store the secret in AWS Secrets Manager under
the name used as `clientSecretRef` (e.g. `CUSTOMER_OIDC_SECRET`) — **no redeploy
required** (ADR-049).

## 4. Customer configures SCIM (optional, enterprise customers)

The admin goes to **Settings → Integrations → SCIM provisioning** and issues a bearer
token (shown once). They configure their IdP (Okta/Entra) with:

- SCIM base URL: `https://app.yourdomain.com/scim/v2`
- Bearer token: the issued token
- Supported operations: Create/Update/Deactivate Users, Create/Update/Delete Groups

SCIM Users map to identities; SCIM Groups map to teams.

## 5. Verify

- **SCIM:** trigger a sync in the IdP; check
  `SELECT * FROM identities WHERE source = 'scim' AND tenant_id = '<id>'`.
- **SSO:** log out; visit
  `https://app.yourdomain.com/auth/sso/login?email=admin@customer.com`; verify the
  redirect to the customer IdP and a successful login.
- **Offboard (if needed):** `npm run delete-tenant -- <tenant-uuid>` (destructive,
  irreversible — erases the tenant from Postgres and ClickHouse).

## Known operational constraint — one env var per SSO customer

Until `AGENTLEDGER_SM_ENABLED=true` is set, each enterprise customer's OIDC client
secret requires one env var on the API container. This scales to ~10–15 customers
before it becomes painful. **Enable AWS Secrets Manager before your ~10th enterprise
customer** to avoid a redeploy per new tenant.
