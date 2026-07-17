# Temporary CloudFront distribution in front of the ALB.
#
# Purpose: provide public HTTPS termination WITHOUT a custom domain or ACM cert,
# using the free *.cloudfront.net certificate, until badgeriq.app is registered
# and the ACM/HTTPS/Route 53 path (enable_custom_domain) is ready.
#
# CloudFront terminates TLS on the public side and talks to the ALB over plain
# HTTP:80 (origin_protocol_policy = "http-only"), matching the ALB's HTTP-only
# listener when enable_custom_domain = false.
#
# Gated behind var.enable_cloudfront so this whole layer can be removed cleanly
# later. This app is dynamic (API responses, live dashboard pages), so caching
# is disabled entirely (all TTLs 0) and all headers/cookies/query strings are
# forwarded to the origin.

resource "aws_cloudfront_distribution" "main" {
  count = var.enable_cloudfront ? 1 : 0

  enabled         = true
  comment         = "${local.name} - temporary HTTPS termination in front of ALB"
  price_class     = "PriceClass_100"
  is_ipv6_enabled = true

  origin {
    domain_name = aws_lb.main.dns_name
    origin_id   = "${local.name}-alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "${local.name}-alb"
    viewer_protocol_policy  = "redirect-to-https"
    allowed_methods         = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods          = ["GET", "HEAD"]

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

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = local.tags
}
