# Phase 4 - Internet-facing ALB. The custom-domain layer (ACM certificate,
# HTTPS listener, Route 53 records) is optional behind var.enable_custom_domain:
#
#   enable_custom_domain = false (default): the ALB serves traffic directly over
#     HTTP:80. Path-based rules (/proxy/*, /ops/*, /backend/*, /*) attach to the
#     HTTP listener. No domain, ACM cert, or Route 53 records are created. This
#     unblocks apply when badgeriq.app is not yet registered/DNS-validatable.
#
#   enable_custom_domain = true: ACM cert (DNS-validated), an HTTPS:443 listener,
#     an HTTP:80 -> HTTPS redirect, and a Route 53 A-alias record. Path-based
#     rules attach to the HTTPS listener.
#
# The active listener the ALB-exposed services attach their rules to is exposed
# as local.alb_service_listener_arn.

locals {
  alb_service_listener_arn = var.enable_custom_domain ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
}

# ── ALB security group ───────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  description = "Internet-facing ALB - ingress 80/443 from anywhere"
  vpc_id      = module.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.name}-alb" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "HTTP from internet"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS from internet"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_ecs" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = module.network.ecs_task_security_group_id
  ip_protocol                  = "-1"
  description                  = "All traffic to ECS tasks"
}

resource "aws_vpc_security_group_ingress_rule" "ecs_from_alb" {
  security_group_id            = module.network.ecs_task_security_group_id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "-1"
  description                  = "All traffic from ALB"
}

# ── ALB ──────────────────────────────────────────────────────────────────────

resource "aws_lb" "main" {
  name               = "${local.name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.network.public_subnet_ids

  tags = local.tags
}

# HTTP:80 listener.
#   - custom domain ON:  redirect to HTTPS:443.
#   - custom domain OFF: serve directly; path rules attach here, default 404.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = var.enable_custom_domain ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  dynamic "default_action" {
    for_each = var.enable_custom_domain ? [] : [1]
    content {
      type = "fixed-response"
      fixed_response {
        content_type = "application/json"
        message_body = "{\"error\":\"not_found\"}"
        status_code  = "404"
      }
    }
  }

  tags = local.tags
}

# HTTPS:443 -> default 404 (service-specific rules added by ecs-service modules).
# Only created when a custom domain (and thus an ACM cert) exists.
resource "aws_lb_listener" "https" {
  count = var.enable_custom_domain ? 1 : 0

  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.pilot[0].certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":\"not_found\"}"
      status_code  = "404"
    }
  }

  tags = local.tags
}

# ── ACM certificate (DNS-validated) ──────────────────────────────────────────
# Entire domain layer is gated on enable_custom_domain.

resource "aws_acm_certificate" "pilot" {
  count = var.enable_custom_domain ? 1 : 0

  domain_name       = "${var.environment}.${var.domain_name}"
  validation_method = "DNS"
  tags              = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = var.enable_custom_domain ? {
    for dvo in aws_acm_certificate.pilot[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id = var.hosted_zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]

  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "pilot" {
  count = var.enable_custom_domain ? 1 : 0

  certificate_arn         = aws_acm_certificate.pilot[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# ── Route 53 A-alias: pilot.badgeriq.app -> ALB ─────────────────────────────

resource "aws_route53_record" "pilot" {
  count = var.enable_custom_domain ? 1 : 0

  zone_id = var.hosted_zone_id
  name    = "${var.environment}.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
