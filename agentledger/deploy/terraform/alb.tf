# Internet-facing ALB hardened as a CloudFront origin:
#   - HTTPS:443 when a certificate is available (custom-domain ACM or alb_certificate_arn)
#   - HTTP:80 always redirects to HTTPS when HTTPS is enabled; otherwise fixed 403
#   - Security group ingress locked to the CloudFront origin-facing prefix list
#   - Listener default action is 403; service rules add host-header allowlists
#
# A fully internal (private) ALB requires CloudFront VPC Origins or VPN and is
# intentionally deferred — see comments at the bottom of waf.tf.

locals {
  custom_hostname = var.enable_custom_domain ? "${var.environment}.${var.domain_name}" : ""

  # Certificate: imported ARN wins; else DNS-validated ACM from custom domain.
  alb_certificate_arn = (
    var.alb_certificate_arn != ""
    ? var.alb_certificate_arn
    : (var.enable_custom_domain ? aws_acm_certificate_validation.pilot[0].certificate_arn : "")
  )

  alb_https_enabled = local.alb_certificate_arn != ""

  alb_service_listener_arn = (
    local.alb_https_enabled
    ? aws_lb_listener.https[0].arn
    : aws_lb_listener.http.arn
  )

  # Hostnames allowed on forward rules (Studio Designer / BadgerIQ + CF domain).
  # ALB host_header conditions accept at most 5 values per rule.
  allowed_host_headers = distinct(concat(
    var.allowed_host_headers,
    local.custom_hostname != "" ? [local.custom_hostname] : [],
    var.enable_cloudfront ? [aws_cloudfront_distribution.main[0].domain_name] : [],
  ))
}

check "alb_host_header_limit" {
  assert {
    condition     = length(local.allowed_host_headers) <= 5
    error_message = "allowed_host_headers (including custom hostname + CloudFront domain) must have at most 5 values per ALB rule."
  }
}

# ── ALB security group ───────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  description = "ALB origin - ingress from CloudFront (and optional break-glass CIDRs)"
  vpc_id      = module.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.name}-alb" })

  lifecycle {
    create_before_destroy = true
  }
}

# CloudFront origin-facing managed prefix list (regional).
data "aws_ec2_managed_prefix_list" "cloudfront" {
  count = var.enable_cloudfront ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

# When CloudFront is the public edge, lock ALB ingress to the CF prefix list.
# The origin-facing prefix list expands to ~45 CIDRs; default SG inbound quota
# is 60, so only open the single origin port CloudFront actually uses
# (HTTP:80 until a custom-domain cert enables https-only origin).
resource "aws_vpc_security_group_ingress_rule" "alb_http_cloudfront" {
  count = var.enable_cloudfront && !local.cloudfront_origin_https ? 1 : 0

  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront[0].id
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "HTTP from CloudFront"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_cloudfront" {
  count = var.enable_cloudfront && local.cloudfront_origin_https ? 1 : 0

  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront[0].id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS from CloudFront"
}

# Without CloudFront, keep the ALB reachable from the internet (host-header +
# HTTPS rules still apply). Prefer enabling CloudFront in production.
resource "aws_vpc_security_group_ingress_rule" "alb_http_public" {
  count = var.enable_cloudfront ? 0 : 1

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "HTTP public (no CloudFront)"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_public" {
  count = var.enable_cloudfront ? 0 : 1

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS public (no CloudFront)"
}

# Optional break-glass / office / VPN CIDRs (health checks, emergency access).
resource "aws_vpc_security_group_ingress_rule" "alb_http_breakglass" {
  for_each = toset(var.alb_ingress_cidr_allowlist)

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "HTTP break-glass CIDR"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_breakglass" {
  for_each = toset(var.alb_ingress_cidr_allowlist)

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS break-glass CIDR"
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
  name = "${local.name}-alb"
  # Keep internet-facing for classic CloudFront custom origins. Private scheme
  # (internal = true) is a follow-up once CloudFront VPC Origins are wired.
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.network.public_subnet_ids

  tags = local.tags
}

# HTTP:80 — redirect to HTTPS when a cert exists; otherwise deny (no plaintext app).
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = local.alb_https_enabled ? [1] : []
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
    for_each = local.alb_https_enabled ? [] : [1]
    content {
      type = "fixed-response"
      fixed_response {
        content_type = "application/json"
        message_body = "{\"error\":\"forbidden\"}"
        status_code  = "403"
      }
    }
  }

  tags = local.tags
}

# HTTPS:443 — service path rules attach here when a certificate is configured.
resource "aws_lb_listener" "https" {
  count = local.alb_https_enabled ? 1 : 0

  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.alb_certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":\"forbidden\"}"
      status_code  = "403"
    }
  }

  tags = local.tags
}

# When HTTPS is not yet available (no cert), path rules attach to HTTP:80
# (local.alb_service_listener_arn). Set enable_custom_domain or alb_certificate_arn
# to move rules onto HTTPS:443 with HTTP→443 redirect.

# ── ACM certificate (DNS-validated) ──────────────────────────────────────────

resource "aws_acm_certificate" "pilot" {
  count = var.enable_custom_domain ? 1 : 0

  domain_name               = local.custom_hostname
  subject_alternative_names = length(var.acm_subject_alternative_names) > 0 ? var.acm_subject_alternative_names : null
  validation_method         = "DNS"
  tags                      = local.tags

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

# ── Route 53 A-alias: custom hostname → CloudFront (preferred) or ALB ───────
# When CloudFront is enabled the ALB SG only admits the CF prefix list, so the
# public hostname must resolve to CloudFront — not the ALB DNS name.

resource "aws_route53_record" "pilot" {
  count = var.enable_custom_domain ? 1 : 0

  zone_id = var.hosted_zone_id
  name    = local.custom_hostname
  type    = "A"

  alias {
    name = (
      var.enable_cloudfront
      ? aws_cloudfront_distribution.main[0].domain_name
      : aws_lb.main.dns_name
    )
    zone_id = (
      var.enable_cloudfront
      ? aws_cloudfront_distribution.main[0].hosted_zone_id
      : aws_lb.main.zone_id
    )
    evaluate_target_health = !var.enable_cloudfront
  }
}
