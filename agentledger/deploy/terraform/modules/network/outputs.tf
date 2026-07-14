output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "Public subnet IDs (ALB, NAT)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (ECS tasks, data stores)."
  value       = aws_subnet.private[*].id
}

output "ecs_task_security_group_id" {
  description = "Shared security group for ECS Fargate tasks."
  value       = aws_security_group.ecs_tasks.id
}
