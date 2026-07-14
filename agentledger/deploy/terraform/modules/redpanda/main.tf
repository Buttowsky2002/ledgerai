# Self-hosted Redpanda on ECS Fargate — Kafka-compatible event bus.
#
# Why not MSK Serverless? MSK Serverless has a ~$547/month cluster-hour floor
# regardless of traffic, while self-hosted Redpanda on Fargate costs ~$18/month
# for pilot-scale volume. Collector and ch-insert services connect via the
# standard Kafka wire protocol either way — no application code changes required.

# ── Cloud Map service discovery ──────────────────────────────────────────────

resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "badgeriq.local"
  vpc  = var.vpc_id
  tags = var.tags
}

resource "aws_service_discovery_service" "redpanda" {
  name = "redpanda"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = var.tags
}

# ── EFS for persistent broker data ───────────────────────────────────────────

resource "aws_efs_file_system" "redpanda" {
  creation_token = "${var.name}-redpanda-data"
  encrypted      = true
  tags           = merge(var.tags, { Name = "${var.name}-redpanda-efs" })
}

resource "aws_security_group" "efs" {
  name_prefix = "${var.name}-redpanda-efs-"
  description = "EFS mount targets — ingress from ECS tasks only"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-redpanda-efs" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_ecs" {
  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = var.ecs_task_security_group_id
  from_port                    = 2049
  to_port                      = 2049
  ip_protocol                  = "tcp"
  description                  = "NFS from ECS tasks"
}

resource "aws_vpc_security_group_egress_rule" "efs_out" {
  security_group_id = aws_security_group.efs.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Allow all egress"
}

resource "aws_efs_mount_target" "redpanda" {
  count           = length(var.private_subnet_ids)
  file_system_id  = aws_efs_file_system.redpanda.id
  subnet_id       = var.private_subnet_ids[count.index]
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "redpanda" {
  file_system_id = aws_efs_file_system.redpanda.id

  posix_user {
    uid = 101
    gid = 101
  }

  root_directory {
    path = "/redpanda-data"
    creation_info {
      owner_uid   = 101
      owner_gid   = 101
      permissions = "0755"
    }
  }

  tags = merge(var.tags, { Name = "${var.name}-redpanda-ap" })
}

# ── ECS cluster + task + service ─────────────────────────────────────────────

# NOTE: Redpanda runs in the shared ECS cluster created by the compute module
# (Phase 4). The cluster ARN is passed in via var.ecs_cluster_id. Until that
# module exists, pass the ARN of a manually-created cluster or a temporary one.

resource "aws_cloudwatch_log_group" "redpanda" {
  name              = "/ecs/${var.name}/redpanda"
  retention_in_days = 14
  tags              = var.tags
}

resource "aws_iam_role" "redpanda_task_execution" {
  name_prefix = "${var.name}-rp-exec-"
  tags        = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "redpanda_exec_default" {
  role       = aws_iam_role.redpanda_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "redpanda_task" {
  name_prefix = "${var.name}-rp-task-"
  tags        = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "redpanda_efs" {
  name = "efs-access"
  role = aws_iam_role.redpanda_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "elasticfilesystem:ClientMount",
        "elasticfilesystem:ClientWrite",
        "elasticfilesystem:ClientRootAccess"
      ]
      Resource = aws_efs_file_system.redpanda.arn
    }]
  })
}

resource "aws_ecs_task_definition" "redpanda" {
  family                   = "${var.name}-redpanda"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.redpanda_task_execution.arn
  task_role_arn            = aws_iam_role.redpanda_task.arn
  tags                     = var.tags

  volume {
    name = "redpanda-data"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.redpanda.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.redpanda.id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([{
    name      = "redpanda"
    image     = var.redpanda_image
    essential = true

    command = [
      "redpanda", "start",
      "--smp", "1",
      "--memory", "256M",
      "--reserve-memory", "0M",
      "--overprovisioned",
      "--reactor-backend", "epoll",
      "--kafka-addr", "0.0.0.0:9092",
      "--advertise-kafka-addr", "redpanda.badgeriq.local:9092",
      "--default-log-level", "warn"
    ]

    portMappings = [{
      containerPort = 9092
      protocol      = "tcp"
    }]

    mountPoints = [{
      sourceVolume  = "redpanda-data"
      containerPath = "/var/lib/redpanda/data"
      readOnly      = false
    }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.redpanda.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "redpanda"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "rpk cluster health | grep -q 'Healthy:.*true' || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    linuxParameters = {
      initProcessEnabled = true
    }
  }])
}

data "aws_region" "current" {}

resource "aws_vpc_security_group_ingress_rule" "redpanda_from_ecs" {
  security_group_id            = var.ecs_task_security_group_id
  referenced_security_group_id = var.ecs_task_security_group_id
  from_port                    = 9092
  to_port                      = 9092
  ip_protocol                  = "tcp"
  description                  = "Kafka wire protocol — Redpanda from ECS tasks"
}

resource "aws_ecs_service" "redpanda" {
  name            = "${var.name}-redpanda"
  cluster         = var.ecs_cluster_id
  task_definition = aws_ecs_task_definition.redpanda.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_task_security_group_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.redpanda.arn
  }

  depends_on = [aws_efs_mount_target.redpanda]

  tags = var.tags
}
