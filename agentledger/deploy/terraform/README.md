# BadgerIQ Terraform — AWS managed infrastructure

Provisions all stateful backing services for the BadgerIQ ECS Fargate deployment.
Application compute (ECS cluster, services, ALB) is added in Phase 4.

## Modules

| Module | What it creates |
|--------|----------------|
| `modules/network/` | VPC, 3 public + 3 private subnets, NAT gateway, VPC endpoints (S3, ECR, Secrets Manager, CloudWatch Logs), ECS task security group |
| `modules/postgres/` | RDS PostgreSQL 16, KMS encryption, parameter group (force SSL, slow-query log), least-privilege `app_rw` role, DSN in Secrets Manager |
| `modules/redis/` | ElastiCache Serverless Redis 7, TLS required, endpoint in Secrets Manager (**disabled** — gateway falls back to in-process MemBudgetStore at desired_count=1) |
| `modules/redpanda/` | Self-hosted Redpanda broker on ECS Fargate, Cloud Map discovery at `redpanda.badgeriq.local:9092`, EFS-backed data volume |
| `modules/clickhouse-secret/` | Stores externally provisioned ClickHouse Cloud creds in Secrets Manager |

## Prerequisites

1. Complete the [bootstrap stack](bootstrap/README.md) — S3 backend, DynamoDB lock, OIDC role, Route 53 zone
2. Provision a ClickHouse Cloud instance (free/dev tier) and note the URL, user, and password
3. Create `backend.hcl` with the S3 backend config from the bootstrap outputs
4. Create `pilot.tfvars` (gitignored) with the required variables

## Usage

```bash
cd agentledger/deploy/terraform

terraform init -backend-config=backend.hcl

terraform plan -var-file=pilot.tfvars
terraform apply -var-file=pilot.tfvars
```

### Minimum `pilot.tfvars`

```hcl
environment         = "pilot"
clickhouse_url      = "https://xxx.clickhouse.cloud:8443"
clickhouse_user     = "default"
clickhouse_password = "..."
# Secrets Manager ARNs (create secrets out-of-band; JSON key `secret`):
# jwt_secret_arn             = "arn:aws:secretsmanager:...:secret:badgeriq/pilot/jwt-..."
# connector_secret_key_arn   = "arn:aws:secretsmanager:...:secret:badgeriq/pilot/connector-secret-key-..."
#   → value: {"secret":"<openssl rand -base64 32>"}  # MUST differ from JWT secret
```

All other variables have sensible defaults. See `variables.tf` for the full list.

## Post-apply manual steps

1. **Create Kafka topics** on Redpanda (via `rpk` from inside the VPC):
   ```bash
   rpk topic create events.raw events.dlq \
     --brokers redpanda.badgeriq.local:9092 \
     --partitions 12 --config retention.ms=604800000
   ```

2. **Verify Postgres connectivity** from a bastion or Cloud9:
   ```bash
   psql "$(aws secretsmanager get-secret-value \
     --secret-id badgeriq/pilot/postgres \
     --query SecretString --output text | jq -r .dsn)"
   ```

3. **Verify Redpanda health**:
   ```bash
   rpk cluster health --brokers redpanda.badgeriq.local:9092
   ```

## Edge lockdown (ALB + CloudFront + Entra)

Industry split of concerns — do not conflate these layers:

| Layer | Mechanism | Controls |
|-------|-----------|----------|
| Network | ALB SG → CloudFront managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`) + optional `alb_ingress_cidr_allowlist` | Who can open a TCP connection to the ALB |
| Edge L7 | HTTPS:443 + HTTP→443 redirect, host-header allowlist, default **403**, CloudFront WAF | Which hostnames / protocols are accepted |
| Identity | Entra **OIDC SSO** (`oidc_microsoft_tenant_id` → tenant-locked issuer) | Who can sign in |
| Lifecycle | Entra **SCIM** to `/scim/v2` (bearer token via `ScimAuthGuard`) | Which users/teams exist |

### Enabling HTTPS on the ALB

1. Set `enable_custom_domain = true` (DNS-validated ACM + Route 53) **or** pass `alb_certificate_arn` for a pre-issued cert in the ALB region (`us-east-1`).
2. Service path rules move to the HTTPS listener; HTTP:80 becomes a 301 to 443.
3. With `enable_cloudfront = true` and a custom domain, CloudFront origins the ALB over **https-only:443** using the custom hostname (cert must match). Until then CF keeps `http-only:80` to the ALB DNS name.
4. Public Route 53 for the custom hostname points at **CloudFront** when CF is enabled (ALB is CF-only at the SG).

### Host allowlist

```hcl
allowed_host_headers = [
  "pilot.badgeriq.app",
  "app.studiodesigner.com",
]
```

CloudFront’s `*.cloudfront.net` domain and the custom hostname are appended automatically. Unmatched Host headers hit the listener default **403**.

### Entra tenant lock

```hcl
oidc_microsoft_tenant_id = "<studio-designer-entra-tenant-guid>"
```

Wires `AGENTLEDGER_OIDC_MICROSOFT_TENANT_ID` into the API so Microsoft OIDC uses
`https://login.microsoftonline.com/<tid>/v2.0` instead of `/common/`.

SCIM stays on its own ALB rule (priority 15) with the same host allowlist; it is **not** an ALB authenticate action.

### Follow-ups (out of this stack)

- Attach geo/IP allowlists on admin paths in WAF as needed
- Flip `internal = true` on the ALB only after CloudFront **VPC Origins** are ready

## Security notes

- No connection strings appear in Terraform state outputs — all DSNs are written to Secrets Manager
- Postgres `rds.force_ssl=1` — plaintext connections are rejected
- Redis module kept but disabled at pilot scale (re-enable for multi-replica gateway)
- Redpanda runs inside the ECS task security group — no static Kafka credentials needed
- All data stores accept ingress only from the ECS task security group
- RDS encryption at rest via a dedicated KMS key with automatic rotation
- The superuser password is only in Secrets Manager; the app uses the `app_rw` role
- ALB is internet-facing but SG-locked to CloudFront when `enable_cloudfront = true`

## Outputs

| Output | Sensitive | Description |
|--------|-----------|-------------|
| `vpc_id` | no | VPC ID |
| `private_subnet_ids` | no | For ECS task placement |
| `public_subnet_ids` | no | For ALB placement |
| `ecs_task_security_group_id` | no | Shared SG for Fargate tasks |
| `postgres_dsn_secret_arn` | yes | Secrets Manager ARN for the app DSN |
| `postgres_address` | no | RDS endpoint hostname |
| `redis_endpoint` | no | ElastiCache endpoint (**disabled**) |
| `redis_secret_arn` | yes | Secrets Manager ARN for Redis URL (**disabled**) |
| `redpanda_broker_endpoint` | no | Cloud Map DNS: `redpanda.badgeriq.local:9092` |
| `redpanda_efs_filesystem_id` | no | EFS filesystem for Redpanda data |
| `clickhouse_secret_arn` | yes | Secrets Manager ARN for ClickHouse creds |
| `alb_dns_name` | no | Placeholder (Phase 4) |

## Next phase

Once the gate passes (plan clean, apply succeeds, psql/redis connectivity verified), proceed to **Phase 3** — schema migrations + seed data.
