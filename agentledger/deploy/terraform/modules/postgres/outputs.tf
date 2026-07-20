output "address" {
  description = "RDS endpoint hostname."
  value       = aws_db_instance.main.address
}

output "port" {
  description = "RDS port."
  value       = aws_db_instance.main.port
}

output "security_group_id" {
  description = "Postgres security group ID."
  value       = aws_security_group.postgres.id
}

output "dsn_secret_arn" {
  description = "Secrets Manager ARN containing the app DSN (never in TF state)."
  value       = aws_secretsmanager_secret.postgres.arn
  sensitive   = true
}

output "dsn_secret_name" {
  description = "Secrets Manager secret name."
  value       = aws_secretsmanager_secret.postgres.name
}
