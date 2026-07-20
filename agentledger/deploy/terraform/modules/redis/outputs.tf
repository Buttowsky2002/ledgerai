output "endpoint" {
  description = "ElastiCache Serverless Redis endpoint hostname."
  value       = aws_elasticache_serverless_cache.main.endpoint[0].address
}

output "port" {
  description = "Redis port."
  value       = aws_elasticache_serverless_cache.main.endpoint[0].port
}

output "security_group_id" {
  description = "Redis security group ID."
  value       = aws_security_group.redis.id
}

output "secret_arn" {
  description = "Secrets Manager ARN containing the Redis URL."
  value       = aws_secretsmanager_secret.redis.arn
  sensitive   = true
}

output "secret_name" {
  description = "Secrets Manager secret name."
  value       = aws_secretsmanager_secret.redis.name
}
