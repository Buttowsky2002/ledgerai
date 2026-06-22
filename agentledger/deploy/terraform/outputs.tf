# Outputs a concrete implementation would surface to feed the Helm release.
# Connection strings carrying credentials MUST be marked sensitive and, ideally,
# written to the platform secret manager rather than left in Terraform state
# (CLAUDE.md rule 1). These are stubbed (null) until main.tf is implemented.

output "clickhouse_url" {
  description = "ClickHouse HTTP endpoint → externalServices.clickhouse.url."
  value       = var.clickhouse_endpoint != "" ? var.clickhouse_endpoint : null
}

output "kafka_brokers" {
  description = "Kafka/Redpanda brokers → externalServices.redpanda.brokers."
  value       = var.kafka_brokers != "" ? var.kafka_brokers : null
}

output "postgres_dsn" {
  description = "Control-plane Postgres DSN → agentledger-secrets/AGENTLEDGER_PG_DSN."
  value       = null # populated by the postgres module; sensitive when implemented
  sensitive   = true
}
