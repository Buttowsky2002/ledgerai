variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS task placement."
  type        = list(string)
}

variable "ecs_task_security_group_id" {
  description = "ECS task SG — Redpanda accepts Kafka-protocol connections from this group."
  type        = string
}

variable "redpanda_image" {
  description = "Redpanda container image."
  type        = string
  default     = "docker.redpanda.com/redpandadata/redpanda:v24.1.7"
}

variable "cpu" {
  description = "Fargate vCPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "memory" {
  description = "Fargate memory in MiB."
  type        = number
  default     = 512
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}
