# Reusable ECS Fargate service: task definition + service + optional ALB
# target group/listener rule + Cloud Map service discovery registration.

data "aws_region" "current" {}

locals {
  has_port = var.container_port > 0

  env_pairs    = [for k, v in var.environment : { name = k, value = v }]
  secret_pairs = [for k, v in var.secrets : { name = k, valueFrom = v }]

  port_mappings = local.has_port ? [{
    containerPort = var.container_port
    protocol      = "tcp"
  }] : []

  # No container-level healthCheck: our images (gateway/api and several workers)
  # are distroless and have neither a shell nor curl, so CMD-SHELL checks can
  # never succeed. ALB-facing services rely on the target-group HTTP health
  # check below; workers rely on ECS process liveness alone.
}

# ── CloudWatch log group ─────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "svc" {
  name              = "/ecs/${var.name_prefix}/${var.name}"
  retention_in_days = 14
  tags              = var.tags
}

# ── Task definition ──────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "svc" {
  family                   = "${var.name_prefix}-${var.name}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  tags                     = var.tags

  container_definitions = jsonencode([{
    name      = var.name
    image     = var.image
    essential = true

    repositoryCredentials = {
      credentialsParameter = var.registry_secret_arn
    }

    environment = local.env_pairs
    secrets     = local.secret_pairs

    portMappings = local.port_mappings

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.svc.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = var.name
      }
    }

    linuxParameters = {
      initProcessEnabled = true
    }
  }])
}

# ── Cloud Map service discovery ──────────────────────────────────────────────

resource "aws_service_discovery_service" "svc" {
  name = var.name

  dns_config {
    namespace_id = var.cloudmap_namespace_id

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

# ── ECS service ──────────────────────────────────────────────────────────────

resource "aws_ecs_service" "svc" {
  name            = "${var.name_prefix}-${var.name}"
  cluster         = var.ecs_cluster_id
  task_definition = aws_ecs_task_definition.svc.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_task_security_group_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.svc.arn
  }

  dynamic "load_balancer" {
    for_each = var.expose_via_alb ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.svc[0].arn
      container_name   = var.name
      container_port   = var.container_port
    }
  }

  tags = var.tags
}

# ── ALB target group + listener rule (conditional) ───────────────────────────

resource "aws_lb_target_group" "svc" {
  count       = var.expose_via_alb ? 1 : 0
  name        = substr("${var.name_prefix}-${var.name}", 0, 32)
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = var.health_check_path
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  tags = var.tags
}

resource "aws_lb_listener_rule" "svc" {
  count        = var.expose_via_alb ? 1 : 0
  listener_arn = var.alb_listener_arn
  priority     = var.alb_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc[0].arn
  }

  condition {
    path_pattern {
      values = var.alb_path_patterns
    }
  }

  dynamic "condition" {
    for_each = length(var.alb_host_headers) > 0 ? [1] : []
    content {
      host_header {
        values = var.alb_host_headers
      }
    }
  }

  tags = var.tags
}
