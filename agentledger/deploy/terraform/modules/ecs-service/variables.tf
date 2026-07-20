variable "name" {
  description = "Service name (used in resource naming and Cloud Map registration)."
  type        = string
}

variable "name_prefix" {
  description = "Global resource name prefix (e.g. badgeriq-pilot)."
  type        = string
}

variable "image" {
  description = "Full container image URI (e.g. ghcr.io/org/repo:tag)."
  type        = string
}

variable "container_port" {
  description = "Port the container listens on. Set to 0 for worker-tier services with no listener."
  type        = number
  default     = 0
}

variable "health_check_path" {
  description = "HTTP path for the container health check."
  type        = string
  default     = "/healthz"
}

variable "cpu" {
  description = "Fargate vCPU units (256 = 0.25 vCPU)."
  type        = number
}

variable "memory" {
  description = "Fargate memory in MiB."
  type        = number
}

variable "environment" {
  description = "Plain-text environment variables (name -> value)."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secret environment variables (name -> Secrets Manager ARN with JSON key selector, e.g. arn:...:secret:name:jsonkey::)."
  type        = map(string)
  default     = {}
}

variable "expose_via_alb" {
  description = "Whether to create a target group and ALB listener rule for this service."
  type        = bool
  default     = false
}

variable "alb_listener_arn" {
  description = "HTTPS listener ARN to attach rules to (required when expose_via_alb = true)."
  type        = string
  default     = ""
}

variable "alb_path_patterns" {
  description = "Path patterns for the ALB listener rule (e.g. [\"/auth/*\", \"/v1/*\"]). Max 5 values."
  type        = list(string)
  default     = []
}

variable "alb_priority" {
  description = "ALB listener rule priority (lower = evaluated first)."
  type        = number
  default     = 100
}

variable "execution_role_arn" {
  description = "IAM role ARN for ECS task execution (image pull + secret fetch)."
  type        = string
}

variable "ecs_cluster_id" {
  description = "ECS cluster ARN."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS task placement."
  type        = list(string)
}

variable "ecs_task_security_group_id" {
  description = "Shared security group for ECS Fargate tasks."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID (for ALB target group)."
  type        = string
}

variable "cloudmap_namespace_id" {
  description = "Cloud Map private DNS namespace ID (badgeriq.local)."
  type        = string
}

variable "registry_secret_arn" {
  description = "Secrets Manager ARN for private registry credentials (GHCR)."
  type        = string
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}
