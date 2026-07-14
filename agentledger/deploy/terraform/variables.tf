# ── Core ──────────────────────────────────────────────────────────────────────

variable "environment" {
  description = "Deployment environment (pilot or prod). No default — force explicit choice."
  type        = string

  validation {
    condition     = contains(["pilot", "prod"], var.environment)
    error_message = "environment must be 'pilot' or 'prod'."
  }
}

variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Root domain managed in Route 53."
  type        = string
  default     = "badgeriq.app"
}

variable "tags" {
  description = "Extra tags merged onto all resources."
  type        = map(string)
  default     = {}
}

# ── Network ──────────────────────────────────────────────────────────────────

variable "vpc_cidr" {
  description = "VPC CIDR block."
  type        = string
  default     = "10.42.0.0/16"
}

# ── Postgres ─────────────────────────────────────────────────────────────────

variable "postgres_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "postgres_multi_az" {
  description = "Enable Multi-AZ for Postgres. false for pilot."
  type        = bool
  default     = false
}

# ── ClickHouse Cloud (externally provisioned) ────────────────────────────────

variable "clickhouse_url" {
  description = "ClickHouse Cloud HTTPS endpoint."
  type        = string
  sensitive   = true
}

variable "clickhouse_user" {
  description = "ClickHouse Cloud username."
  type        = string
  sensitive   = true
}

variable "clickhouse_password" {
  description = "ClickHouse Cloud password."
  type        = string
  sensitive   = true
}
