# CloudFront-scoped WAFv2 WebACL — companion to ALB host-header lockdown.
#
# Follow-up (not in this pass): flip the ALB to internal = true and front it
# with CloudFront VPC Origins so the origin is unreachable from the public
# internet even if SG rules are misconfigured.

resource "aws_wafv2_web_acl" "edge" {
  count = var.enable_waf && var.enable_cloudfront ? 1 : 0

  name        = "${local.name}-edge"
  description = "Edge WAF for ${local.name}: AWS managed common rules + auth/SCIM rate limits"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        # CRS SizeRestrictions_BODY blocks any POST > 8 KB. Billing CSV preview
        # posts the file as JSON (~40 KB+), so CloudFront returns an HTML 403
        # and the dashboard reports "server returned a web page instead of JSON".
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-common"
      sampled_requests_enabled   = true
    }
  }

  # Keep an 8 KB body cap everywhere except billing CSV import (Nest allows 20 MB).
  rule {
    name     = "BlockOversizedBodyExceptPortalImport"
    priority = 2

    action {
      block {}
    }

    statement {
      and_statement {
        statement {
          size_constraint_statement {
            comparison_operator = "GT"
            size                = 8192
            field_to_match {
              body {
                oversize_handling = "MATCH"
              }
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
        statement {
          not_statement {
            statement {
              byte_match_statement {
                positional_constraint = "STARTS_WITH"
                search_string         = "/api/portal-import"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "LOWERCASE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-oversize-body"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitAuth"
    priority = 10

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            positional_constraint = "STARTS_WITH"
            search_string         = "/auth/"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate-auth"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitScim"
    priority = 11

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 1000
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            positional_constraint = "STARTS_WITH"
            search_string         = "/scim/"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate-scim"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-edge"
    sampled_requests_enabled   = true
  }

  tags = local.tags
}
