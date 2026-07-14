# BadgerIQ managed infrastructure — AWS ECS Fargate deployment.
#
# Design constraints (CLAUDE.md + ADR-039):
#   - Postgres: RLS-capable; least-privilege app role separate from superuser (rule 7).
#   - ClickHouse: externally provisioned (ClickHouse Cloud); ordering keys start
#     with tenant_id (handled by migrations).
#   - Secrets: connection strings go into Secrets Manager, NOT Terraform state
#     outputs in plaintext (rule 1). All sensitive outputs are marked sensitive.
#   - Encrypt at rest; TLS everywhere (rule 9).
#   - Private networking between compute and data stores.

locals {
  name           = "badgeriq-${var.environment}"
  secret_prefix  = "badgeriq/${var.environment}"

  tags = merge(
    {
      "app.kubernetes.io/part-of" = "agentledger"
      project                     = "badgeriq"
      environment                 = var.environment
      managed_by                  = "terraform"
    },
    var.tags,
  )
}

# ── 1. Network ────────────────────────────────────────────────────────────────

module "network" {
  source = "./modules/network"

  name               = local.name
  vpc_cidr           = var.vpc_cidr
  aws_region         = var.aws_region
  single_nat_gateway = var.environment == "pilot"
  tags               = local.tags
}

# ── 2. PostgreSQL 16 (control plane, RLS) ─────────────────────────────────────

module "postgres" {
  source = "./modules/postgres"

  name                      = local.name
  vpc_id                    = module.network.vpc_id
  private_subnet_ids        = module.network.private_subnet_ids
  ecs_task_security_group_id = module.network.ecs_task_security_group_id
  instance_class            = var.postgres_instance_class
  multi_az                  = var.postgres_multi_az
  secret_prefix             = local.secret_prefix
  tags                      = local.tags
}

# ── 3. Redis (gateway budget store) ───────────────────────────────────────────
#
# DISABLED: the gateway's BudgetStore falls back to an in-process MemBudgetStore
# when BADGERIQ_REDIS_ADDR is unset, which is sufficient at desired_count=1.
# Re-enable this module when running multiple gateway replicas requires shared
# budget/rate-limit state.
#
# module "redis" {
#   source = "./modules/redis"
#
#   name                       = local.name
#   vpc_id                     = module.network.vpc_id
#   private_subnet_ids         = module.network.private_subnet_ids
#   ecs_task_security_group_id = module.network.ecs_task_security_group_id
#   secret_prefix              = local.secret_prefix
#   tags                       = local.tags
# }

# ── 4. ECS cluster (shared by all Fargate services) ──────────────────────────
#
# Single cluster for Redpanda + all application services (Phase 4).
# When the compute module is built, this resource moves there and the cluster
# ARN is passed back to root as a module output.

# Re-enable containerInsights when per-task granular metrics justify ~$10–40/month.
resource "aws_ecs_cluster" "main" {
  name = "${local.name}-cluster"
  tags = local.tags
}

# ── 5. Redpanda (Kafka-compatible event bus on ECS Fargate) ──────────────────
#
# Replaces the MSK Serverless module (modules/kafka/) which was deleted.
# Rationale: MSK Serverless has a ~$547/month cluster-hour floor regardless of
# traffic, while self-hosted Redpanda on Fargate costs ~$18/month for pilot-scale
# volume. Collector/ch-insert services connect via the standard Kafka wire
# protocol either way — no application code changes required.

module "redpanda" {
  source = "./modules/redpanda"

  name                       = local.name
  vpc_id                     = module.network.vpc_id
  private_subnet_ids         = module.network.private_subnet_ids
  ecs_task_security_group_id = module.network.ecs_task_security_group_id
  ecs_cluster_id             = aws_ecs_cluster.main.id
  tags                       = local.tags
}

# ── 6. ClickHouse Cloud connection secret ─────────────────────────────────────

module "clickhouse_secret" {
  source = "./modules/clickhouse-secret"

  secret_prefix       = local.secret_prefix
  clickhouse_url      = var.clickhouse_url
  clickhouse_user     = var.clickhouse_user
  clickhouse_password = var.clickhouse_password
  tags                = local.tags
}
