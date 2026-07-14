# RDS PostgreSQL 16 — control plane, RLS-capable. Single-AZ for pilot;
# flip postgres_multi_az before GA.

resource "aws_kms_key" "postgres" {
  description             = "${var.name} RDS encryption key"
  deletion_window_in_days = 14
  enable_key_rotation     = true
  tags                    = var.tags
}

resource "aws_kms_alias" "postgres" {
  name          = "alias/${var.name}-postgres"
  target_key_id = aws_kms_key.postgres.key_id
}

# ── Security group (ingress from ECS tasks only) ─────────────────────────────

resource "aws_security_group" "postgres" {
  name_prefix = "${var.name}-postgres-"
  description = "RDS PostgreSQL - ingress from ECS tasks only"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-postgres" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "postgres_from_ecs" {
  security_group_id            = aws_security_group.postgres.id
  referenced_security_group_id = var.ecs_task_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from ECS tasks"
}

resource "aws_vpc_security_group_egress_rule" "postgres_out" {
  security_group_id = aws_security_group.postgres.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Allow all egress"
}

# ── Subnet group ──────────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "main" {
  name       = "${var.name}-postgres"
  subnet_ids = var.private_subnet_ids
  tags       = var.tags
}

# ── Parameter group (TLS required, slow query logging) ────────────────────────

resource "aws_db_parameter_group" "main" {
  name_prefix = "${var.name}-pg16-"
  family      = "postgres16"
  description = "BadgerIQ PostgreSQL 16 - force SSL, log slow queries"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = var.tags
}

# ── RDS instance ──────────────────────────────────────────────────────────────

resource "random_password" "superuser" {
  length  = 32
  special = false
}

resource "random_password" "app_role" {
  length  = 32
  special = false
}

resource "aws_db_instance" "main" {
  identifier     = "${var.name}-postgres"
  engine         = "postgres"
  engine_version = "16"

  instance_class        = var.instance_class
  allocated_storage     = 100
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.postgres.arn
  multi_az              = var.multi_az
  db_name               = "agentledger"
  username              = "badgeriq_admin"
  password              = random_password.superuser.result
  db_subnet_group_name  = aws_db_subnet_group.main.name
  parameter_group_name  = aws_db_parameter_group.main.name
  vpc_security_group_ids = [aws_security_group.postgres.id]

  backup_retention_period = 7
  deletion_protection     = true
  skip_final_snapshot     = false
  final_snapshot_identifier = "${var.name}-postgres-final"
  copy_tags_to_snapshot   = true

  performance_insights_enabled = true
  monitoring_interval          = 60
  monitoring_role_arn          = aws_iam_role.rds_monitoring.arn

  tags = var.tags
}

# ── Enhanced monitoring IAM role ──────────────────────────────────────────────

resource "aws_iam_role" "rds_monitoring" {
  name = "${var.name}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
  # Note: the double-colon above is correct — AWS global IAM policy ARNs omit the account ID.

}

# ── App role provisioning (least-privilege, rule 7) ───────────────────────────
# Creates app_rw role that the application uses instead of the superuser.

resource "null_resource" "app_role" {
  depends_on = [aws_db_instance.main]

  provisioner "local-exec" {
    environment = {
      PGHOST     = aws_db_instance.main.address
      PGPORT     = tostring(aws_db_instance.main.port)
      PGDATABASE = "agentledger"
      PGUSER     = aws_db_instance.main.username
      PGPASSWORD = random_password.superuser.result
      PGSSLMODE  = "require"
      APP_PW     = random_password.app_role.result
    }

    command = <<-EOT
      psql -v ON_ERROR_STOP=1 <<'SQL'
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') THEN
            CREATE ROLE app_rw WITH LOGIN PASSWORD current_setting('app.app_pw') NOINHERIT;
          END IF;
        END $$;
        SET app.app_pw = :'APP_PW';
        ALTER ROLE app_rw WITH PASSWORD :'APP_PW';
        GRANT CONNECT ON DATABASE agentledger TO app_rw;
        GRANT USAGE ON SCHEMA public TO app_rw;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_rw;
      SQL
    EOT
  }

  triggers = {
    instance_id = aws_db_instance.main.id
  }
}

# ── Store the app DSN in Secrets Manager ──────────────────────────────────────

resource "aws_secretsmanager_secret" "postgres" {
  name = "${var.secret_prefix}/postgres"
  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "postgres" {
  secret_id = aws_secretsmanager_secret.postgres.id
  secret_string = jsonencode({
    dsn           = "postgres://app_rw:${random_password.app_role.result}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/agentledger?sslmode=require"
    host          = aws_db_instance.main.address
    port          = aws_db_instance.main.port
    database      = "agentledger"
    username      = "app_rw"
    password      = random_password.app_role.result
    admin_username = aws_db_instance.main.username
    admin_password = random_password.superuser.result
  })
}
