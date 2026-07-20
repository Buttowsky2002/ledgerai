output "secret_arn" {
  description = "Secrets Manager ARN for the ClickHouse connection details."
  value       = aws_secretsmanager_secret.clickhouse.arn
  sensitive   = true
}

output "secret_name" {
  description = "Secrets Manager secret name."
  value       = aws_secretsmanager_secret.clickhouse.name
}
