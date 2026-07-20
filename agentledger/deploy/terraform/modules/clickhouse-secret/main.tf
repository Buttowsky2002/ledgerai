# ClickHouse Cloud connection details in Secrets Manager.
# The ClickHouse Cloud instance is provisioned by hand (free/dev tier during
# pilot) — this module stores its connection string so ECS tasks can read it
# without the values leaking into Terraform state outputs.

resource "aws_secretsmanager_secret" "clickhouse" {
  name = "${var.secret_prefix}/clickhouse"
  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "clickhouse" {
  secret_id = aws_secretsmanager_secret.clickhouse.id
  secret_string = jsonencode({
    url      = var.clickhouse_url
    user     = var.clickhouse_user
    password = var.clickhouse_password
    database = var.clickhouse_database
  })
}
