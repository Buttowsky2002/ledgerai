output "bootstrap_brokers_sasl_iam" {
  description = "MSK Serverless bootstrap brokers (IAM SASL)."
  value       = aws_msk_serverless_cluster.main.bootstrap_brokers_sasl_iam
}

output "cluster_arn" {
  description = "MSK cluster ARN."
  value       = aws_msk_serverless_cluster.main.arn
}

output "security_group_id" {
  description = "MSK security group ID."
  value       = aws_security_group.msk.id
}
