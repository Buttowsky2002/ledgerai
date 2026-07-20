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

# ── ECS cluster ───────────────────────────────────────────────────────────────

output "ecs_cluster_arn" {
  description = "Shared ECS Fargate cluster ARN."
  value       = aws_ecs_cluster.main.arn
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

# ── Redis (disabled — see main.tf) ────────────────────────────────────────────
#
# output "redis_endpoint" {
#   description = "ElastiCache Serverless Redis endpoint."
#   value       = module.redis.endpoint
# }
#
# output "redis_secret_arn" {
#   description = "Secrets Manager ARN for Redis connection."
#   value       = module.redis.secret_arn
#   sensitive   = true
# }

# ── Redpanda (Kafka-compatible event bus) ────────────────────────────────────

output "redpanda_broker_endpoint" {
  description = "Redpanda broker Cloud Map DNS name (Kafka wire protocol)."
  value       = module.redpanda.broker_endpoint
}

output "redpanda_efs_filesystem_id" {
  description = "EFS filesystem ID backing Redpanda data."
  value       = module.redpanda.efs_filesystem_id
}

# ── ClickHouse ────────────────────────────────────────────────────────────────

output "clickhouse_secret_arn" {
  description = "Secrets Manager ARN for ClickHouse Cloud credentials."
  value       = module.clickhouse_secret.secret_arn
  sensitive   = true
}

# ── Phase 4: ALB + DNS ───────────────────────────────────────────────────────

output "alb_dns_name" {
  description = "ALB DNS name."
  value       = aws_lb.main.dns_name
}

output "alb_arn" {
  description = "ALB ARN."
  value       = aws_lb.main.arn
}

output "alb_url" {
  description = "Base URL to reach the ALB: HTTPS custom domain when enabled, otherwise the plain-HTTP ALB DNS name."
  value       = var.enable_custom_domain ? "https://${var.environment}.${var.domain_name}" : "http://${aws_lb.main.dns_name}"
}

output "pilot_url" {
  description = "Public custom-domain URL (only meaningful when enable_custom_domain = true)."
  value       = "https://${var.environment}.${var.domain_name}"
}

output "acm_certificate_arn" {
  description = "ACM certificate ARN for the custom domain (null when enable_custom_domain = false)."
  value       = var.enable_custom_domain ? aws_acm_certificate.pilot[0].arn : null
}

output "ecs_execution_role_arn" {
  description = "Shared ECS execution role ARN."
  value       = aws_iam_role.ecs_execution.arn
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name (*.cloudfront.net), null when enable_cloudfront = false."
  value       = var.enable_cloudfront ? aws_cloudfront_distribution.main[0].domain_name : null
}
