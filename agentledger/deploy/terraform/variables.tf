# ── Core ──────────────────────────────────────────────────────────────────────

variable "environment" {
  description = "Deployment environment (pilot or prod). No default - force explicit choice."
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

# ── Phase 4: ECS services + ALB + DNS ────────────────────────────────────────

variable "enable_custom_domain" {
  description = "Provision the ACM cert, HTTPS listener, and Route 53 records for a real domain. When false, the ALB serves traffic over plain HTTP:80 (no domain required)."
  type        = bool
  default     = false
}

variable "enable_cloudfront" {
  description = "Provision a CloudFront distribution in front of the ALB for HTTPS termination without a custom domain (temporary until domain registration completes)."
  type        = bool
  default     = false
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone ID for domain_name (created in bootstrap). Only used when enable_custom_domain = true."
  type        = string
  default     = ""
}

variable "ghcr_secret_arn" {
  description = "Secrets Manager ARN for GHCR private registry credentials (username/password JSON)."
  type        = string
}

variable "image_tag" {
  description = "Container image tag for all ECS services (semver or sha from the release workflow; :latest is never published)."
  type        = string
  default     = "latest"
}

variable "anthropic_secret_arn" {
  description = "Secrets Manager ARN containing {api_key: ...} for the Anthropic API."
  type        = string
}

variable "jwt_secret_arn" {
  description = "Secrets Manager ARN containing {secret: ...} for JWT signing."
  type        = string
}

variable "oidc_google_secret_arn" {
  description = "Secrets Manager ARN containing {client_id, client_secret} for Google OIDC. Optional."
  type        = string
  default     = ""
}

variable "oidc_microsoft_secret_arn" {
  description = "Secrets Manager ARN containing {client_id, client_secret} for Microsoft OIDC. Optional."
  type        = string
  default     = ""
}

variable "github_token_secret_arn" {
  description = "Secrets Manager ARN containing {token: ...} for GitHub API access (outcome sync)."
  type        = string
}
