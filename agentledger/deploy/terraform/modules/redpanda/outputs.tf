output "broker_endpoint" {
  description = "Cloud Map DNS name for the Redpanda broker (Kafka wire protocol, port 9092)."
  value       = "${aws_service_discovery_service.redpanda.name}.${aws_service_discovery_private_dns_namespace.main.name}:9092"
}

output "efs_filesystem_id" {
  description = "EFS filesystem ID backing /var/lib/redpanda/data."
  value       = aws_efs_file_system.redpanda.id
}

output "service_arn" {
  description = "ECS service ARN for the Redpanda broker."
  value       = aws_ecs_service.redpanda.id
}
