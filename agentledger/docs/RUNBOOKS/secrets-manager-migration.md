# Runbook — Migrate connector credentials to AWS Secrets Manager

**Status:** plan only (no application code in this change)  
**Owner:** control-plane / platform  
**Related:** Phase 3 (`BADGERIQ_CONNECTOR_SECRET_KEY`), `ConnectorSecretsService`, migration `014_api_connector_framework.sql`

---

## 1. Current state

Connector credentials today are stored **in Postgres**, not in Secrets Manager.

| Piece | Location | Notes |
|-------|----------|--------|
| Ciphertext | `connector_secrets.ciphertext` | AES-256-GCM blob (IV ‖ tag ‖ ciphertext), base64 |
| Row key | `connector_secrets.secret_id` (UUID) | Returned by `storeSecret()` |
| Link from connector | `connectors.secret_ref` | Holds the `secret_id` UUID (not an ARN) |
| Encryption key | ECS / env | `BADGERIQ_CONNECTOR_SECRET_KEY` (32+ chars). Historical code also accepted JWT-secret / `dev-only-connector-key` fallbacks — those must be gone before cutover (see Phase 3 PR). |
| Resolve path | `ConnectorSecretsService.resolveSecret(secretRef)` | RLS-scoped `findUnique` → decrypt in process |
| Consumers | API connectors, GitHub Copilot sync, etc. | Call `resolveSecret` at sync time |

**Risks of the current design**

- The AES key is a long-lived env/secret injected into the task — compromise of the task role + env dumps all connector credentials after decrypt.
- No CloudTrail per-credential access trail (only app logs / optional `connector.secret_access` security_audit events).
- Key rotation requires re-encrypting every `connector_secrets` row.
- No native AWS rotation for OAuth refresh tokens.

---

## 2. Target state

Each connector credential lives in **AWS Secrets Manager** as its own secret. Postgres holds only a reference.

| Piece | Target |
|-------|--------|
| Secret name | `badgeriq/{tenantId}/{connectorId}/credential` |
| Secret value | JSON, e.g. `{ "token": "…", "type": "api_key" \| "oauth_refresh" }` — **never** log this |
| Postgres | `connectors.secret_arn` (new column) = full secret ARN |
| Legacy | `connectors.secret_ref` + `connector_secrets` retained until migration verified, then deleted |
| IAM | ECS task role may `secretsmanager:GetSecretValue` (and later `PutSecretValue` / rotation role) only on `badgeriq/*` |

Example ARN pattern (account from pilot):

```text
arn:aws:secretsmanager:us-east-1:995475749441:secret:badgeriq/<tenantUuid>/<connectorUuid>/credential-XXXXXX
```

**Resolve order after dual-read ships**

1. If `connectors.secret_arn` is set → `GetSecretValue` for that ARN (tenant must match path).
2. Else if `connectors.secret_ref` is set → existing Postgres decrypt path.
3. Else → no credential.

New writes after cutover **only** create Secrets Manager secrets and set `secret_arn` (no new `connector_secrets` rows).

---

## 3. Migration steps

### 3.1 Schema

Add a forward-only Postgres migration (next free number after applied migrations, e.g. `029_connector_secret_arn.sql`):

```sql
ALTER TABLE connectors
  ADD COLUMN IF NOT EXISTS secret_arn TEXT;

-- Optional: reject obviously wrong ARNs at write time in the API, not via CHECK
-- (ARN format varies by region / random suffix).

COMMENT ON COLUMN connectors.secret_arn IS
  'AWS Secrets Manager ARN for connector credential; when set, preferred over secret_ref';
```

Update Prisma `Connector` model + regenerate client in the same implementation PR (not this docs PR).

### 3.2 Application dual-read / dual-write

Update `ConnectorSecretsService` (implementation PR):

1. **`resolveSecret` / new `resolveForConnector(connector)`**  
   - Prefer `secret_arn` → Secrets Manager.  
   - Fall back to `secret_ref` → Postgres ciphertext.  
   - Emit `connector.secret_access` security audit with `{ source: 'secrets_manager' | 'postgres', connectorId }` — never plaintext.

2. **`storeSecret` / create-connector flow**  
   - Feature flag `BADGERIQ_CONNECTOR_SECRETS_BACKEND=secrets_manager|postgres` (default `postgres` until cutover).  
   - When `secrets_manager`: `CreateSecret` with name `badgeriq/{tenantId}/{connectorId}/credential`, store ARN on the connector, do **not** insert `connector_secrets`.

3. **Tenant isolation**  
   - Parse ARN / name; refuse if `{tenantId}` segment ≠ `getTenantId()`.  
   - Fail closed on mismatch (treat as BOLA).

4. **AWS SDK**  
   - Prefer `@aws-sdk/client-secrets-manager` with default credential chain (task role).  
   - No static AWS keys in env.

### 3.3 Background migration job

One-shot (or resumable) Nest CLI / worker, run with a privileged ops identity:

For each `connectors` row where `secret_ref IS NOT NULL` AND `secret_arn IS NULL`:

1. Load `connector_secrets` by `secret_ref` under that tenant’s RLS.  
2. Decrypt with current `BADGERIQ_CONNECTOR_SECRET_KEY`.  
3. `CreateSecret` (or `PutSecretValue` if name exists) named `badgeriq/{tenantId}/{connectorId}/credential`.  
4. `UPDATE connectors SET secret_arn = $arn WHERE connector_id = $id`.  
5. **Do not delete** Postgres ciphertext yet (see Rollback).  
6. Record progress in `audit_log` / ops table (`migrated_at`, `secret_arn`).

Idempotency: if `secret_arn` already set, skip. If CreateSecret returns `ResourceExistsException`, `DescribeSecret` + reuse ARN.

Dry-run mode: decrypt + log counts only, no AWS writes.

### 3.4 ECS / IAM

On the **API** (and any sync worker that resolves connector secrets) task role:

```json
{
  "Effect": "Allow",
  "Action": [
    "secretsmanager:GetSecretValue",
    "secretsmanager:DescribeSecret"
  ],
  "Resource": "arn:aws:secretsmanager:us-east-1:995475749441:secret:badgeriq/*"
}
```

For the **migration job** (and create/update connector paths after cutover), also:

```json
"Action": [
  "secretsmanager:CreateSecret",
  "secretsmanager:PutSecretValue",
  "secretsmanager:TagResource"
]
```

Tag every secret: `app=badgeriq`, `tenant_id=…`, `connector_id=…`.

Terraform: add a dedicated IAM policy module attachment; do **not** put credential plaintext in task `environment`. After cutover, remove `BADGERIQ_CONNECTOR_SECRET_KEY` from the task once Postgres ciphertext is gone (keep available in Secrets Manager / SSM for emergency re-encrypt until then).

### 3.5 Cutover checklist

1. Ship dual-read code behind flag; deploy API.  
2. Run migration job dry-run → review counts.  
3. Run migration job for real in staging → verify syncs.  
4. Run in production; monitor `connector.secret_access` + sync error rates.  
5. Flip default write path to `secrets_manager`.  
6. After soak (recommended ≥ 14 days): delete migrated `connector_secrets` rows; drop key from task env when unused.

---

## 4. Rollback

| Stage | Action |
|-------|--------|
| During migration | Keep all `connector_secrets` rows. Dual-read still works if Secrets Manager is unavailable (optional: circuit-breaker → Postgres). |
| After `secret_arn` populated | To roll back reads: clear `secret_arn` (or set flag `prefer_postgres=true`) so resolve uses `secret_ref` again. |
| After ciphertext deleted | Rollback requires restoring ciphertext from a DB backup **or** re-importing secrets from Secrets Manager into Postgres (script: GetSecretValue → encrypt → insert). Practice this in staging once. |
| IAM / outage | If SM is down and Postgres fallback was already deleted, syncs fail closed — prefer keeping ciphertext until SM SLOs are proven. |

**Rule:** Do not `DELETE FROM connector_secrets` until every connector with a former `secret_ref` has a verified `secret_arn` and a successful sync using SM.

---

## 5. Rotation

### 5.1 Static API keys (OpenAI, Anthropic admin keys, etc.)

- Prefer **manual / ticketed rotation**: operator creates a new key at the provider, updates the SM secret via console or `PutSecretValue`, then invalidates the old provider key.  
- Optional: Secrets Manager **rotation Lambda** that only works if the provider exposes a “create key / revoke key” API — most LLM providers do not; document as **manual**.  
- App behavior: always `GetSecretValue` at sync start (no long-lived in-memory cache beyond the request), so `PutSecretValue` is picked up on the next sync.

### 5.2 OAuth refresh tokens (GitHub App, etc.)

- Store JSON: `{ "type": "oauth_refresh", "refresh_token": "…", "access_token": "…", "expires_at": "…" }`.  
- **Application-managed rotation:** on refresh, `PutSecretValue` the new tokens (same ARN). Do **not** rely on SM’s generic rotation schedule for OAuth — the IdP owns validity.  
- Optional SM rotation Lambda is a poor fit unless it can call the IdP token endpoint with client credentials from a *separate* SM secret.

### 5.3 Encryption-key rotation (AES / `BADGERIQ_CONNECTOR_SECRET_KEY`)

After SM cutover this key is only needed for remaining Postgres rows. Procedure while dual-store exists:

1. Introduce `BADGERIQ_CONNECTOR_SECRET_KEY_PREVIOUS` for decrypt-only.  
2. Set new primary key; re-encrypt remaining rows.  
3. Drop previous.  

Once Postgres ciphertext is gone, retire both keys.

---

## 6. Security requirements (non-negotiable)

1. No secret plaintext in git, Terraform state inputs, logs, or `audit_log.detail`.  
2. ARN / name must embed tenant id; API must verify against RLS tenant.  
3. Least privilege: read-only on the sync path; write only on admin create/update + migration role.  
4. Continue emitting structured `connector.secret_access` (Phase 9) with source, never values.  
5. Document the new env flag and IAM ARNs in `docs/ENVIRONMENT.md` and Terraform when implementing.

---

## 7. Implementation PR split (suggested)

| PR | Scope |
|----|--------|
| A | Migration `secret_arn` + Prisma |
| B | Dual-read `ConnectorSecretsService` + IAM Terraform |
| C | Migration CLI/job + dry-run |
| D | Default writes to SM + delete ciphertext soak |

This runbook is **PR 0** (docs only).
