# CloudFront distribution in front of the ALB.
#
# Public HTTPS always terminates here (*.cloudfront.net and/or custom aliases).
# Origin protocol:
#   - https-only on :443 when the ALB has a cert CloudFront can trust
#     (custom domain / ACM on the origin hostname)
#   - http-only on :80 otherwise (interim until enable_custom_domain or
#     alb_certificate_arn covers the origin hostname)
#
# ALB security group admits only the CloudFront origin-facing prefix list, so
# this distribution is the sole public path to the app.

locals {
  # Prefer a custom-domain origin hostname so the ALB ACM cert matches.
  cloudfront_origin_domain = (
    local.alb_https_enabled && var.enable_custom_domain
    ? local.custom_hostname
    : aws_lb.main.dns_name
  )

  cloudfront_origin_https = local.alb_https_enabled && var.enable_custom_domain

  cloudfront_aliases = (
    var.enable_cloudfront && var.enable_custom_domain
    ? distinct(concat([local.custom_hostname], var.acm_subject_alternative_names))
    : []
  )
}

resource "aws_cloudfront_distribution" "main" {
  count = var.enable_cloudfront ? 1 : 0

  enabled             = true
  comment             = "${local.name} - HTTPS edge in front of ALB origin"
  price_class         = "PriceClass_100"
  is_ipv6_enabled     = true
  aliases             = local.cloudfront_aliases
  web_acl_id          = length(aws_wafv2_web_acl.edge) > 0 ? aws_wafv2_web_acl.edge[0].arn : null
  default_root_object = ""

  origin {
    domain_name = local.cloudfront_origin_domain
    origin_id   = "${local.name}-alb"

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = local.cloudfront_origin_https ? "https-only" : "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }
  }

  default_cache_behavior {
    target_origin_id       = "${local.name}-alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    # Dynamic app: forward everything, cache nothing.
    forwarded_values {
      query_string = true
      headers      = ["*"]

      cookies {
        forward = "all"
      }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  dynamic "viewer_certificate" {
    for_each = length(local.cloudfront_aliases) > 0 ? [1] : []
    content {
      acm_certificate_arn      = local.alb_certificate_arn
      ssl_support_method       = "sni-only"
      minimum_protocol_version = "TLSv1.2_2021"
    }
  }

  dynamic "viewer_certificate" {
    for_each = length(local.cloudfront_aliases) == 0 ? [1] : []
    content {
      cloudfront_default_certificate = true
    }
  }

  tags = local.tags
}
