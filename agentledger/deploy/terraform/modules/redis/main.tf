# ElastiCache Serverless Redis 7 — gateway budget store. TLS required (rule 9).

resource "aws_security_group" "redis" {
  name_prefix = "${var.name}-redis-"
  description = "ElastiCache Redis - ingress from ECS tasks only"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-redis" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_ecs" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = var.ecs_task_security_group_id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "Redis from ECS tasks"
}

resource "aws_vpc_security_group_egress_rule" "redis_out" {
  security_group_id = aws_security_group.redis.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Allow all egress"
}

resource "aws_elasticache_serverless_cache" "main" {
  engine = "redis"
  name   = "${var.name}-redis"

  major_engine_version = "7"

  cache_usage_limits {
    data_storage {
      maximum = 1
      unit    = "GB"
    }
    ecpu_per_second {
      maximum = 1000
    }
  }

  security_group_ids = [aws_security_group.redis.id]
  subnet_ids         = var.private_subnet_ids

  tags = var.tags
}

# ── Store endpoint in Secrets Manager ─────────────────────────────────────────

resource "aws_secretsmanager_secret" "redis" {
  name = "${var.secret_prefix}/redis"
  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    url      = "rediss://${aws_elasticache_serverless_cache.main.endpoint[0].address}:${aws_elasticache_serverless_cache.main.endpoint[0].port}"
    endpoint = aws_elasticache_serverless_cache.main.endpoint[0].address
    port     = aws_elasticache_serverless_cache.main.endpoint[0].port
  })
}
