variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for the cache subnet group."
  type        = list(string)
}

variable "ecs_task_security_group_id" {
  description = "ECS task SG - only source allowed to reach Redis."
  type        = string
}

variable "secret_prefix" {
  description = "Secrets Manager path prefix (e.g. badgeriq/pilot)."
  type        = string
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}
