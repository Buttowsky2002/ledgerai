# BadgerIQ Terraform — AWS managed infrastructure

Provisions all stateful backing services for the BadgerIQ ECS Fargate deployment.
Application compute (ECS cluster, services, ALB) is added in Phase 4.

## Modules

| Module | What it creates |
|--------|----------------|
| `modules/network/` | VPC, 3 public + 3 private subnets, NAT gateway, VPC endpoints (S3, ECR, Secrets Manager, CloudWatch Logs), ECS task security group |
| `modules/postgres/` | RDS PostgreSQL 16, KMS encryption, parameter group (force SSL, slow-query log), least-privilege `app_rw` role, DSN in Secrets Manager |
| `modules/redis/` | ElastiCache Serverless Redis 7, TLS required, endpoint in Secrets Manager |
| `modules/kafka/` | MSK Serverless (IAM SASL auth), 3-AZ networking |
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
```

All other variables have sensible defaults. See `variables.tf` for the full list.

## Post-apply manual steps

1. **Create Kafka topics** — MSK Serverless doesn't support Terraform-managed topics:
   ```bash
   # See the kafka module TODO block for the full commands
   ```

2. **Verify Postgres connectivity** from a bastion or Cloud9:
   ```bash
   psql "$(aws secretsmanager get-secret-value \
     --secret-id badgeriq/pilot/postgres \
     --query SecretString --output text | jq -r .dsn)"
   ```

3. **Verify Redis connectivity**:
   ```bash
   ENDPOINT=$(aws secretsmanager get-secret-value \
     --secret-id badgeriq/pilot/redis \
     --query SecretString --output text | jq -r .endpoint)
   redis-cli -h "$ENDPOINT" --tls PING
   ```

## Security notes

- No connection strings appear in Terraform state outputs — all DSNs are written to Secrets Manager
- Postgres `rds.force_ssl=1` — plaintext connections are rejected
- Redis `transit_encryption_enabled` via ElastiCache Serverless (always TLS)
- MSK uses IAM SASL — no static Kafka credentials
- All data stores accept ingress only from the ECS task security group
- RDS encryption at rest via a dedicated KMS key with automatic rotation
- The superuser password is only in Secrets Manager; the app uses the `app_rw` role

## Outputs

| Output | Sensitive | Description |
|--------|-----------|-------------|
| `vpc_id` | no | VPC ID |
| `private_subnet_ids` | no | For ECS task placement |
| `public_subnet_ids` | no | For ALB placement |
| `ecs_task_security_group_id` | no | Shared SG for Fargate tasks |
| `postgres_dsn_secret_arn` | yes | Secrets Manager ARN for the app DSN |
| `postgres_address` | no | RDS endpoint hostname |
| `redis_endpoint` | no | ElastiCache endpoint |
| `redis_secret_arn` | yes | Secrets Manager ARN for Redis URL |
| `kafka_bootstrap_brokers` | no | MSK bootstrap string |
| `kafka_cluster_arn` | no | MSK cluster ARN |
| `clickhouse_secret_arn` | yes | Secrets Manager ARN for ClickHouse creds |
| `alb_dns_name` | no | Placeholder (Phase 4) |

## Next phase

Once the gate passes (plan clean, apply succeeds, psql/redis connectivity verified), proceed to **Phase 3** — schema migrations + seed data.
