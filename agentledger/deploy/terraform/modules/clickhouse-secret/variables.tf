variable "secret_prefix" {
  description = "Secrets Manager path prefix (e.g. badgeriq/pilot)."
  type        = string
}

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

variable "clickhouse_database" {
  description = "ClickHouse database name."
  type        = string
  default     = "agentledger"
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}
