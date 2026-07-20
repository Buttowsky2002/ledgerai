variable "aws_region" {
  description = "AWS region for bootstrap resources (us-east-1 for pilot)."
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Root domain for the Route 53 hosted zone (delegate NS at your registrar)."
  type        = string
  default     = "badgeriq.app"
}

variable "github_repository" {
  description = "GitHub repository allowed to assume the deployer role (OWNER/REPO)."
  type        = string
  default     = "Buttowsky2002/ledgerai"
}

variable "project_name" {
  description = "Prefix for bootstrap resource names."
  type        = string
  default     = "badgeriq"
}

variable "tags" {
  description = "Extra tags merged onto all bootstrap resources."
  type        = map(string)
  default     = {}
}
