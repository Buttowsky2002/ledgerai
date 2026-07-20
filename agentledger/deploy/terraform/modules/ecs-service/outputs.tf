output "service_arn" {
  description = "ECS service ARN."
  value       = aws_ecs_service.svc.id
}

output "task_definition_arn" {
  description = "ECS task definition ARN."
  value       = aws_ecs_task_definition.svc.arn
}

output "cloudmap_service_arn" {
  description = "Cloud Map service ARN."
  value       = aws_service_discovery_service.svc.arn
}

output "target_group_arn" {
  description = "ALB target group ARN (empty string if not ALB-exposed)."
  value       = var.expose_via_alb ? aws_lb_target_group.svc[0].arn : ""
}
