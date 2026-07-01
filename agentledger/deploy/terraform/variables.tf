# Inputs describing the managed infrastructure BadgerIQ expects. These are
# stable; the resources that consume them (main.tf) are stubbed per ADR-039.

variable "environment" {
  description = "Deployment environment name (e.g. dev, staging, prod)."
  type        = string
  default     = "dev"
}

variable "region" {
  description = "Cloud region for the managed services."
  type        = string
  default     = ""
}

variable "cluster_name" {
  description = "Kubernetes cluster name the BadgerIQ Helm release targets."
  type        = string
  default     = "agentledger"
}

variable "postgres_version" {
  description = "Managed PostgreSQL major version (control plane requires 16)."
  type        = string
  default     = "16"
}

variable "postgres_instance_size" {
  description = "Managed PostgreSQL instance class/size (cloud-specific string)."
  type        = string
  default     = ""
}

variable "clickhouse_endpoint" {
  description = "ClickHouse HTTP endpoint (managed or self-hosted) for analytics."
  type        = string
  default     = ""
}

variable "kafka_brokers" {
  description = "Redpanda/Kafka bootstrap brokers for the events bus."
  type        = string
  default     = ""
}

variable "enable_redis" {
  description = "Provision a managed Redis for the gateway budget store."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags/labels applied to all provisioned resources."
  type        = map(string)
  default     = {}
}
