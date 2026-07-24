# Phase 4 - All 11 BadgerIQ application services on ECS Fargate.
#
# Shared wiring passed to every module instance:
#   - execution_role_arn   = aws_iam_role.ecs_execution.arn  (Part 1)
#   - ecs_cluster_id       = aws_ecs_cluster.main.id
#   - private_subnet_ids   = module.network.private_subnet_ids
#   - ecs_task_sg          = module.network.ecs_task_security_group_id
#   - vpc_id               = module.network.vpc_id
#   - cloudmap_namespace   = module.redpanda.namespace_id   (badgeriq.local)
#   - registry_secret_arn  = var.ghcr_secret_arn
#   - alb_listener_arn     = local.alb_service_listener_arn (HTTPS:443 when a
#                            cert is configured, otherwise HTTP:80 — see alb.tf)
#   - alb_host_headers     = local.allowed_host_headers (domain lockdown)

locals {
  svc_common = {
    name_prefix                = local.name
    execution_role_arn         = aws_iam_role.ecs_execution.arn
    ecs_cluster_id             = aws_ecs_cluster.main.id
    private_subnet_ids         = module.network.private_subnet_ids
    ecs_task_security_group_id = module.network.ecs_task_security_group_id
    vpc_id                     = module.network.vpc_id
    cloudmap_namespace_id      = module.redpanda.namespace_id
    registry_secret_arn        = var.ghcr_secret_arn
    tags                       = local.tags
  }

  pg_dsn_secret  = "${module.postgres.dsn_secret_arn}:dsn::"
  ch_url_secret  = "${module.clickhouse_secret.secret_arn}:url::"
  ch_user_secret = "${module.clickhouse_secret.secret_arn}:user::"
  ch_pass_secret = "${module.clickhouse_secret.secret_arn}:password::"

  # Browser-facing origin (OIDC login links). No path suffix — ALB matches Nest
  # paths (/auth/*, /v1/*, …) directly. Prefer custom domain; else CloudFront.
  public_url = (
    var.enable_custom_domain
    ? "https://${var.environment}.${var.domain_name}"
    : "https://${aws_cloudfront_distribution.main[0].domain_name}"
  )
}

# ── 1. Gateway (Go) ─────────────────────────────────────────────────────────

module "gateway" {
  source = "./modules/ecs-service"

  name           = "gateway"
  image          = "ghcr.io/buttowsky2002/ledgerai-gateway:${var.image_tag}"
  container_port = 8080
  cpu            = 512
  memory         = 1024

  environment = {
    AGENTLEDGER_CONFIG = "/etc/agentledger/config.json"
  }

  secrets = {
    ANTHROPIC_API_KEY            = "${var.anthropic_secret_arn}:api_key::"
    BADGERIQ_CLICKHOUSE_URL      = local.ch_url_secret
    BADGERIQ_CLICKHOUSE_PASSWORD = local.ch_pass_secret
  }

  expose_via_alb    = true
  alb_listener_arn  = local.alb_service_listener_arn
  alb_path_patterns = ["/proxy/*", "/ops/*"]
  alb_host_headers  = local.allowed_host_headers
  alb_priority      = 10

  name_prefix                = local.svc_common.name_prefix
  execution_role_arn         = local.svc_common.execution_role_arn
  ecs_cluster_id             = local.svc_common.ecs_cluster_id
  private_subnet_ids         = local.svc_common.private_subnet_ids
  ecs_task_security_group_id = local.svc_common.ecs_task_security_group_id
  vpc_id                     = local.svc_common.vpc_id
  cloudmap_namespace_id      = local.svc_common.cloudmap_namespace_id
  registry_secret_arn        = local.svc_common.registry_secret_arn
  tags                       = local.svc_common.tags
}

# ── 2. API (NestJS) ─────────────────────────────────────────────────────────

module "api" {
  source = "./modules/ecs-service"

  name           = "api"
  image          = "ghcr.io/buttowsky2002/ledgerai-api:${var.image_tag}"
  container_port = 8094
  cpu            = 512
  memory         = 1024

  environment = merge(
    {
      NODE_ENV = "production"
      # Alias-aware production gate for API auth safety (dev-trust / docs).
      BADGERIQ_ENV = "production"
      # Public origin for OIDC redirect_uri (must match IdP app registration).
      # Same host as dashboard BADGERIQ_PUBLIC_URL — not the Cloud Map address.
      BADGERIQ_OIDC_REDIRECT_BASE = local.public_url
      # Post-login browser redirect target (auth.controller dashboardUrl).
      BADGERIQ_DASHBOARD_URL = local.public_url
      # OIDC returns cross-site; SameSite=Strict session cookies are dropped on
      # the post-IdP redirect to the dashboard → bounce back to /login. Lax keeps
      # al_access/al_refresh on that top-level navigation (same public host).
      BADGERIQ_COOKIE_SAMESITE = "lax"
      # Design-partner → attribution engine via Cloud Map (not localhost).
      BADGERIQ_ATTRIBUTION_WORKER_URL = "http://attribution.badgeriq.local:8096"
    },
    var.oidc_microsoft_tenant_id != "" ? {
      # Lock Microsoft OIDC to the Studio Designer Entra tenant (not /common/).
      AGENTLEDGER_OIDC_MICROSOFT_TENANT_ID = var.oidc_microsoft_tenant_id
    } : {},
  )

  secrets = {
    AGENTLEDGER_PG_DSN         = local.pg_dsn_secret
    AGENTLEDGER_CLICKHOUSE_URL = local.ch_url_secret
    AGENTLEDGER_JWT_SECRET     = "${var.jwt_secret_arn}:secret::"
    # Dedicated AES key for connector credentials — never reuse the JWT secret.
    BADGERIQ_CONNECTOR_SECRET_KEY            = "${var.connector_secret_key_arn}:secret::"
    AGENTLEDGER_OIDC_MICROSOFT_CLIENT_ID     = "${var.oidc_microsoft_secret_arn}:client_id::"
    AGENTLEDGER_OIDC_MICROSOFT_CLIENT_SECRET = "${var.oidc_microsoft_secret_arn}:client_secret::"
  }

  expose_via_alb   = true
  alb_listener_arn = local.alb_service_listener_arn
  # Nest has no setGlobalPrefix — controllers mount at /auth, /v1/*, /scim/v2,
  # /healthz, /readyz (and /metrics, /docs internally). /scim/* has its own
  # higher-priority listener rule below. ALB max 5 path values per rule.
  alb_path_patterns = ["/auth/*", "/v1/*", "/healthz", "/readyz"]
  alb_host_headers  = local.allowed_host_headers
  alb_priority      = 20

  name_prefix                = local.svc_common.name_prefix
  execution_role_arn         = local.svc_common.execution_role_arn
  ecs_cluster_id             = local.svc_common.ecs_cluster_id
  private_subnet_ids         = local.svc_common.private_subnet_ids
  ecs_task_security_group_id = local.svc_common.ecs_task_security_group_id
  vpc_id                     = local.svc_common.vpc_id
  cloudmap_namespace_id      = local.svc_common.cloudmap_namespace_id
  registry_secret_arn        = local.svc_common.registry_secret_arn
  tags                       = local.svc_common.tags
}

# SCIM lifecycle (/scim/v2) — dedicated higher-priority rule. Auth stays at the
# app layer (ScimAuthGuard bearer token); this is host/path edge lockdown only.
resource "aws_lb_listener_rule" "scim" {
  listener_arn = local.alb_service_listener_arn
  priority     = 15

  action {
    type             = "forward"
    target_group_arn = module.api.target_group_arn
  }

  condition {
    path_pattern {
      values = ["/scim/*"]
    }
  }

  dynamic "condition" {
    for_each = length(local.allowed_host_headers) > 0 ? [1] : []
    content {
      host_header {
        values = local.allowed_host_headers
      }
    }
  }

  tags = local.svc_common.tags
}

# ── 3. Dashboard (Next.js) ──────────────────────────────────────────────────

module "dashboard" {
  source = "./modules/ecs-service"

  name           = "dashboard"
  image          = "ghcr.io/buttowsky2002/ledgerai-dashboard:${var.image_tag}"
  container_port = 3000
  cpu            = 512
  memory         = 1024

  environment = {
    NODE_ENV     = "production"
    BADGERIQ_ENV = "production"
    # Server-side BFF only (lib/api.ts). Use Cloud Map — never round-trip the ALB.
    # Service discovery: aws_service_discovery_service.svc.name = var.name ("api")
    # in namespace badgeriq.local → api.badgeriq.local:8094
    BADGERIQ_API_URL = "http://api.badgeriq.local:8094"
    # Browser-facing OIDC login links (lib/auth.ts loginUrl) — public hostname.
    BADGERIQ_PUBLIC_URL = local.public_url
    BADGERIQ_DEMO_MODE  = "false"
  }

  secrets = {}

  expose_via_alb    = true
  alb_listener_arn  = local.alb_service_listener_arn
  alb_path_patterns = ["/*"]
  alb_host_headers  = local.allowed_host_headers
  alb_priority      = 100

  name_prefix                = local.svc_common.name_prefix
  execution_role_arn         = local.svc_common.execution_role_arn
  ecs_cluster_id             = local.svc_common.ecs_cluster_id
  private_subnet_ids         = local.svc_common.private_subnet_ids
  ecs_task_security_group_id = local.svc_common.ecs_task_security_group_id
  vpc_id                     = local.svc_common.vpc_id
  cloudmap_namespace_id      = local.svc_common.cloudmap_namespace_id
  registry_secret_arn        = local.svc_common.registry_secret_arn
  tags                       = local.svc_common.tags
}

# ── 4. Collector (Go) ───────────────────────────────────────────────────────

module "collector" {
  source = "./modules/ecs-service"

  name           = "collector"
  image          = "ghcr.io/buttowsky2002/ledgerai-collector:${var.image_tag}"
  container_port = 8090
  cpu            = 256
  memory         = 512

  environment = {
    AGENTLEDGER_KAFKA_BROKERS = "redpanda.badgeriq.local:9092"
    AGENTLEDGER_KAFKA_TOPIC   = "events.raw"
  }

  secrets = {}

  name_prefix                = local.svc_common.name_prefix
  execution_role_arn         = local.svc_common.execution_role_arn
  ecs_cluster_id             = local.svc_common.ecs_cluster_id
  private_subnet_ids         = local.svc_common.private_subnet_ids
  ecs_task_security_group_id = local.svc_common.ecs_task_security_group_id
  vpc_id                     = local.svc_common.vpc_id
  cloudmap_namespace_id      = local.svc_common.cloudmap_namespace_id
  registry_secret_arn        = local.svc_common.registry_secret_arn
  tags                       = local.svc_common.tags
}

# ── 5. CH-Insert worker (Go) ────────────────────────────────────────────────

module "ch_insert" {
  source = "./modules/ecs-service"

  name           = "ch-insert"
  image          = "ghcr.io/buttowsky2002/ledgerai-ch-insert:${var.image_tag}"
  container_port = 8091
  cpu            = 256
  memory         = 512

  environment = {
    AGENTLEDGER_KAFKA_BROKERS   = "redpanda.badgeriq.local:9092"
    AGENTLEDGER_KAFKA_TOPIC     = "events.raw"
    AGENTLEDGER_KAFKA_DLQ_TOPIC = "events.dlq"
  }

  secrets = {
    AGENTLEDGER_CLICKHOUSE_URL      = local.ch_url_secret
    AGENTLEDGER_CLICKHOUSE_USER     = local.ch_user_secret
    AGENTLEDGER_CLICKHOUSE_PASSWORD = local.ch_pass_secret
  }

  name_prefix                = local.svc_common.name_prefix
  execution_role_arn         = local.svc_common.execution_role_arn
  ecs_cluster_id             = local.svc_common.ecs_cluster_id
  private_subnet_ids         = local.svc_common.private_subnet_ids
  ecs_task_security_group_id = local.svc_common.ecs_task_security_group_id
  vpc_id                     = local.svc_common.vpc_id
  cloudmap_namespace_id      = local.svc_common.cloudmap_namespace_id
  registry_secret_arn        = local.svc_common.registry_secret_arn
  tags                       = local.svc_common.tags
}

# ── 6. Reconciliation worker (Go) ───────────────────────────────────────────

module "reconcile" {
  source = "./modules/ecs-service"

  name           = "reconcile"
  image          = "ghcr.io/buttowsky2002/ledgerai-reconcile:${var.image_tag}"
  container_port = 8093
  cpu            = 256
  memory         = 512

  environment = {}

  secrets = {
    AGENTLEDGER_PG_DSN         = local.pg_dsn_secret
    AGENTLEDGER_CLICKHOUSE_URL = local.ch_url_secret
  }

  name_prefix                = local.svc_common.name_prefix
  execution_role_arn         = local.svc_common.execution_role_arn
  ecs_cluster_id             = local.svc_common.ecs_cluster_id
  private_subnet_ids         = local.svc_common.private_subnet_ids
  ecs_task_security_group_id = local.svc_common.ecs_task_security_group_id
  vpc_id                     = local.svc_common.vpc_id
  cloudmap_namespace_id      = local.svc_common.cloudmap_namespace_id
  registry_secret_arn        = local.svc_common.registry_secret_arn
  tags                       = local.svc_common.tags
}

# ── 7. Attribution engine (Go) ──────────────────────────────────────────────

module "attribution" {
  source = "./modules/ecs-service"

  name           = "attribution"
  image          = "ghcr.io/buttowsky2002/ledgerai-attribution:${var.image_tag}"
  container_port = 8096
  cpu            = 256
  memory         = 512

  environment = {}

  secrets = {
    AGENTLEDGER_PG_DSN         = local.pg_dsn_secret
    AGENTLEDGER_CLICKHOUSE_URL = local.ch_url_secret
  }

  name_prefix                = local.svc_common.name_prefix
  execution_role_arn         = local.svc_common.execution_role_arn
  ecs_cluster_id             = local.svc_common.ecs_cluster_id
  private_subnet_ids         = local.svc_common.private_subnet_ids
  ecs_task_security_group_id = local.svc_common.ecs_task_security_group_id
  vpc_id                     = local.svc_common.vpc_id
  cloudmap_namespace_id      = local.svc_common.cloudmap_namespace_id
  registry_secret_arn        = local.svc_common.registry_secret_arn
  tags                       = local.svc_common.tags
}

# ── 8. Risk engine (Go) ─────────────────────────────────────────────────────

module "risk_engine" {
  source = "./modules/ecs-service"

  name           = "risk-engine"
  image          = "ghcr.io/buttowsky2002/ledgerai-risk-engine:${var.image_tag}"
  container_port = 8099
  cpu            = 256
  memory         = 512

  environment = {}

  secrets = {
    AGENTLEDGER_CLICKHOUSE_URL = local.ch_url_secret
  }

  name_prefix                = local.svc_common.name_prefix
  execution_role_arn         = local.svc_common.execution_role_arn
  ecs_cluster_id             = local.svc_common.ecs_cluster_id
  private_subnet_ids         = local.svc_common.private_subnet_ids
  ecs_task_security_group_id = local.svc_common.ecs_task_security_group_id
  vpc_id                     = local.svc_common.vpc_id
  cloudmap_namespace_id      = local.svc_common.cloudmap_namespace_id
  registry_secret_arn        = local.svc_common.registry_secret_arn
  tags                       = local.svc_common.tags
}

# ── 9. Connector sync (Go) ──────────────────────────────────────────────────

module "connector_sync" {
  source = "./modules/ecs-service"

  name           = "connector-sync"
  image          = "ghcr.io/buttowsky2002/ledgerai-connector-sync:${var.image_tag}"
  container_port = 8092
  cpu            = 256
  memory         = 512

  environment = {}

  secrets = {
    AGENTLEDGER_PG_DSN         = local.pg_dsn_secret
    AGENTLEDGER_CLICKHOUSE_URL = local.ch_url_secret
  }

  name_prefix                = local.svc_common.name_prefix
  execution_role_arn         = local.svc_common.execution_role_arn
  ecs_cluster_id             = local.svc_common.ecs_cluster_id
  private_subnet_ids         = local.svc_common.private_subnet_ids
  ecs_task_security_group_id = local.svc_common.ecs_task_security_group_id
  vpc_id                     = local.svc_common.vpc_id
  cloudmap_namespace_id      = local.svc_common.cloudmap_namespace_id
  registry_secret_arn        = local.svc_common.registry_secret_arn
  tags                       = local.svc_common.tags
}

# ── 10. Outcome sync (Go) ───────────────────────────────────────────────────

module "outcome_sync" {
  source = "./modules/ecs-service"

  name           = "outcome-sync"
  image          = "ghcr.io/buttowsky2002/ledgerai-outcome-sync:${var.image_tag}"
  container_port = 8095
  cpu            = 256
  memory         = 512

  environment = {}

  secrets = {
    AGENTLEDGER_PG_DSN         = local.pg_dsn_secret
    AGENTLEDGER_CLICKHOUSE_URL = local.ch_url_secret
    GITHUB_TOKEN               = "${var.github_token_secret_arn}:token::"
  }

  name_prefix                = local.svc_common.name_prefix
  execution_role_arn         = local.svc_common.execution_role_arn
  ecs_cluster_id             = local.svc_common.ecs_cluster_id
  private_subnet_ids         = local.svc_common.private_subnet_ids
  ecs_task_security_group_id = local.svc_common.ecs_task_security_group_id
  vpc_id                     = local.svc_common.vpc_id
  cloudmap_namespace_id      = local.svc_common.cloudmap_namespace_id
  registry_secret_arn        = local.svc_common.registry_secret_arn
  tags                       = local.svc_common.tags
}

# ── 11. LiteLLM adapter (Go) ────────────────────────────────────────────────

module "litellm_adapter" {
  source = "./modules/ecs-service"

  name           = "litellm-adapter"
  image          = "ghcr.io/buttowsky2002/ledgerai-litellm-adapter:${var.image_tag}"
  container_port = 8097
  cpu            = 256
  memory         = 512

  environment = {
    AGENTLEDGER_COLLECTOR_URL = "http://collector.badgeriq.local:8090/v1/events"
  }

  secrets = {}

  name_prefix                = local.svc_common.name_prefix
  execution_role_arn         = local.svc_common.execution_role_arn
  ecs_cluster_id             = local.svc_common.ecs_cluster_id
  private_subnet_ids         = local.svc_common.private_subnet_ids
  ecs_task_security_group_id = local.svc_common.ecs_task_security_group_id
  vpc_id                     = local.svc_common.vpc_id
  cloudmap_namespace_id      = local.svc_common.cloudmap_namespace_id
  registry_secret_arn        = local.svc_common.registry_secret_arn
  tags                       = local.svc_common.tags
}
