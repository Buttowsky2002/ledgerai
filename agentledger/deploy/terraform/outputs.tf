# ── Network ────────────────────────────────────────────────────────────────────

output "vpc_id" {
  description = "VPC ID."
  value       = module.network.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (ECS tasks, data stores)."
  value       = module.network.private_subnet_ids
}

output "public_subnet_ids" {
  description = "Public subnet IDs (ALB, NAT)."
  value       = module.network.public_subnet_ids
}

output "ecs_task_security_group_id" {
  description = "Shared security group for ECS Fargate tasks."
  value       = module.network.ecs_task_security_group_id
}

# ── Postgres ──────────────────────────────────────────────────────────────────

output "postgres_dsn_secret_arn" {
  description = "Secrets Manager ARN containing the app DSN."
  value       = module.postgres.dsn_secret_arn
  sensitive   = true
}

output "postgres_address" {
  description = "RDS endpoint hostname."
  value       = module.postgres.address
}

# ── Redis ─────────────────────────────────────────────────────────────────────

output "redis_endpoint" {
  description = "ElastiCache Serverless Redis endpoint."
  value       = module.redis.endpoint
}

output "redis_secret_arn" {
  description = "Secrets Manager ARN for Redis connection."
  value       = module.redis.secret_arn
  sensitive   = true
}

# ── Kafka (MSK Serverless) ────────────────────────────────────────────────────

output "kafka_bootstrap_brokers" {
  description = "MSK Serverless bootstrap brokers (IAM SASL)."
  value       = module.kafka.bootstrap_brokers_sasl_iam
}

output "kafka_cluster_arn" {
  description = "MSK cluster ARN."
  value       = module.kafka.cluster_arn
}

# ── ClickHouse ────────────────────────────────────────────────────────────────

output "clickhouse_secret_arn" {
  description = "Secrets Manager ARN for ClickHouse Cloud credentials."
  value       = module.clickhouse_secret.secret_arn
  sensitive   = true
}

# ── Placeholder for Phase 4 ──────────────────────────────────────────────────

output "alb_dns_name" {
  description = "ALB DNS name (populated in Phase 4 — ECS + ALB)."
  value       = null
}
