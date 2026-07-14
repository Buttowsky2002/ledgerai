variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for the DB subnet group."
  type        = list(string)
}

variable "ecs_task_security_group_id" {
  description = "ECS task SG — only source allowed to reach Postgres."
  type        = string
}

variable "instance_class" {
  description = "RDS instance class (db.t4g.medium for pilot)."
  type        = string
  default     = "db.t4g.medium"
}

variable "multi_az" {
  description = "Enable Multi-AZ. false for pilot, true before GA."
  type        = bool
  default     = false
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
