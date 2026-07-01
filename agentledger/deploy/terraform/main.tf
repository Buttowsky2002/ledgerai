# BadgerIQ managed-infrastructure — STUB (ADR-039).
#
# This file deliberately declares NO live resources. The blocks below document
# the modules a concrete implementation would add, per target cloud. Uncomment
# and wire the chosen cloud's provider + modules in a dedicated follow-up PR.
#
# Design constraints carried from CLAUDE.md:
#   - Postgres: enable RLS-capable instance; create a least-privilege app role
#     separate from the bootstrap superuser (rule 7); TLS required (rule 9).
#   - ClickHouse: ordering keys start with tenant_id (handled by migrations).
#   - Secrets: emit connection strings into the platform secret manager, NOT into
#     Terraform state outputs in plaintext (rule 1) — mark outputs sensitive and
#     prefer writing to a secrets backend.
#   - Encrypt at rest; private networking between the cluster and data stores.

locals {
  name = "agentledger-${var.environment}"
  tags = merge({ "app.kubernetes.io/part-of" = "agentledger", environment = var.environment }, var.tags)
}

# --- Kubernetes cluster -------------------------------------------------------
# module "cluster" {
#   source = "./modules/<cloud>-kubernetes"
#   name   = var.cluster_name
#   region = var.region
#   tags   = local.tags
# }

# --- PostgreSQL 16 (control plane, RLS) --------------------------------------
# module "postgres" {
#   source         = "./modules/<cloud>-postgres"
#   name           = "${local.name}-pg"
#   engine_version = var.postgres_version
#   instance_size  = var.postgres_instance_size
#   # outputs: dsn (sensitive) → write to secret manager, not state
# }

# --- ClickHouse (analytics) ---------------------------------------------------
# module "clickhouse" {
#   source   = "./modules/clickhouse"
#   endpoint = var.clickhouse_endpoint
# }

# --- Redpanda / Kafka (events bus) -------------------------------------------
# module "kafka" {
#   source  = "./modules/<cloud>-kafka"
#   brokers = var.kafka_brokers
# }

# --- Redis (optional gateway budget store) -----------------------------------
# module "redis" {
#   count  = var.enable_redis ? 1 : 0
#   source = "./modules/<cloud>-redis"
#   name   = "${local.name}-redis"
# }
