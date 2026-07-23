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
  description = "Provision a DNS-validated ACM cert, HTTPS:443 listener, HTTP→443 redirect, and Route 53 alias for environment.domain_name."
  type        = bool
  default     = false
}

variable "alb_certificate_arn" {
  description = "Optional pre-existing ACM certificate ARN for the ALB HTTPS listener (us-east-1). When set, HTTPS is enabled even if enable_custom_domain = false."
  type        = string
  default     = ""
}

variable "acm_subject_alternative_names" {
  description = "Optional SANs on the DNS-validated ACM cert (e.g. app.studiodesigner.com)."
  type        = list(string)
  default     = []
}

variable "allowed_host_headers" {
  description = "Extra Host header values allowed on ALB forward rules (Studio Designer / BadgerIQ hostnames). CloudFront domain and custom hostname are added automatically."
  type        = list(string)
  default     = []
}

variable "alb_ingress_cidr_allowlist" {
  description = "Optional CIDRs allowed to hit the ALB in addition to the CloudFront prefix list (office/VPN break-glass)."
  type        = list(string)
  default     = []
}

variable "oidc_microsoft_tenant_id" {
  description = "Entra (Azure AD) tenant ID. When set, Microsoft OIDC uses https://login.microsoftonline.com/<tid>/v2.0 instead of /common/."
  type        = string
  default     = ""
}

variable "enable_waf" {
  description = "Attach an AWS WAF WebACL to the CloudFront distribution (managed common rules + auth/SCIM rate limits)."
  type        = bool
  default     = true
}

variable "enable_cloudfront" {
  description = "Provision a CloudFront distribution in front of the ALB for public HTTPS termination."
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

variable "connector_secret_key_arn" {
  description = "Secrets Manager ARN containing {secret: ...} for connector credential encryption (AES). Must be distinct from jwt_secret_arn."
  type        = string
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
