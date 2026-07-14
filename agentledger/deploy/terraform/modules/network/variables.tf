variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR block."
  type        = string
  default     = "10.42.0.0/16"
}

variable "aws_region" {
  description = "AWS region (for VPC endpoint service names)."
  type        = string
}

variable "single_nat_gateway" {
  description = "Use a single NAT gateway (pilot cost savings). Set false for HA before GA."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}
