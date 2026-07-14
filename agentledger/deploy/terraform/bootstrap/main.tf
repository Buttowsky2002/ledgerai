# Bootstrap stack — applied once by hand. Holds the remote state backend for the
# main BadgerIQ Terraform stack (deploy/terraform/). See README.md.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  tfstate_bucket = "${var.project_name}-tfstate-${local.account_id}-${local.region}"
  lock_table     = "${var.project_name}-tfstate-lock"

  tags = merge(
    {
      project     = var.project_name
      managed_by  = "terraform-bootstrap"
      environment = "shared"
    },
    var.tags,
  )
}

# ── 1. Terraform remote state (S3 + versioning + encryption) ─────────────────

resource "aws_s3_bucket" "tfstate" {
  bucket = local.tfstate_bucket
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    id     = "archive-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_transition {
      noncurrent_days = 90
      storage_class   = "GLACIER"
    }
  }
}

# ── 2. Terraform state lock (DynamoDB) ─────────────────────────────────────

resource "aws_dynamodb_table" "tfstate_lock" {
  name         = local.lock_table
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}

# ── 3. GitHub Actions OIDC identity provider ────────────────────────────────

resource "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list = [
    "sts.amazonaws.com",
  ]

  # GitHub Actions OIDC root CA thumbprint (verify periodically).
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
  ]
}

# ── 4. GitHub deployer role (tag releases only) ─────────────────────────────

data "aws_iam_policy_document" "github_deployer_trust" {
  statement {
    effect = "Allow"

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    actions = ["sts:AssumeRoleWithWebIdentity"]

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repository}:ref:refs/tags/v*.*.*",
      ]
    }
  }
}

resource "aws_iam_role" "github_deployer" {
  name               = "${var.project_name}-github-deployer"
  assume_role_policy = data.aws_iam_policy_document.github_deployer_trust.json
}

# ── Policy 1/3: state + network ──────────────────────────────────────────────

data "aws_iam_policy_document" "deployer_state_and_network" {
  statement {
    sid = "TerraformStateS3"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.tfstate.arn,
      "${aws_s3_bucket.tfstate.arn}/*",
    ]
  }

  statement {
    sid = "TerraformStateLock"
    actions = [
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
    ]
    resources = [
      aws_dynamodb_table.tfstate_lock.arn,
    ]
  }

  statement {
    sid = "NetworkDescribe"
    actions = [
      "ec2:Describe*",
      "ec2:CreateTags",
      "ec2:DeleteTags",
      "ec2:CreateVpc",
      "ec2:DeleteVpc",
      "ec2:ModifyVpcAttribute",
      "ec2:CreateSubnet",
      "ec2:DeleteSubnet",
      "ec2:CreateInternetGateway",
      "ec2:DeleteInternetGateway",
      "ec2:AttachInternetGateway",
      "ec2:DetachInternetGateway",
      "ec2:CreateNatGateway",
      "ec2:DeleteNatGateway",
      "ec2:AllocateAddress",
      "ec2:ReleaseAddress",
      "ec2:CreateRouteTable",
      "ec2:DeleteRouteTable",
      "ec2:CreateRoute",
      "ec2:ReplaceRoute",
      "ec2:DeleteRoute",
      "ec2:AssociateRouteTable",
      "ec2:DisassociateRouteTable",
      "ec2:CreateSecurityGroup",
      "ec2:DeleteSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:CreateVpcEndpoint",
      "ec2:DeleteVpcEndpoint",
      "ec2:ModifyVpcEndpoint",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "deployer_state_and_network" {
  name        = "${var.project_name}-deployer-state-network"
  description = "Deployer: Terraform state (S3/DynamoDB) + VPC/network/SG."
  policy      = data.aws_iam_policy_document.deployer_state_and_network.json
}

resource "aws_iam_role_policy_attachment" "deployer_state_and_network" {
  role       = aws_iam_role.github_deployer.name
  policy_arn = aws_iam_policy.deployer_state_and_network.arn
}

# ── Policy 2/3: compute + data ──────────────────────────────────────────────

data "aws_iam_policy_document" "deployer_compute_and_data" {
  statement {
    sid = "ECS"
    actions = [
      "ecs:CreateCluster",
      "ecs:DeleteCluster",
      "ecs:DescribeClusters",
      "ecs:ListClusters",
      "ecs:UpdateCluster",
      "ecs:CreateService",
      "ecs:UpdateService",
      "ecs:DeleteService",
      "ecs:DescribeServices",
      "ecs:ListServices",
      "ecs:RegisterTaskDefinition",
      "ecs:DeregisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
      "ecs:ListTaskDefinitions",
      "ecs:TagResource",
      "ecs:UntagResource",
      "ecs:ListTagsForResource",
    ]
    resources = ["*"]
  }

  statement {
    sid = "RDS"
    actions = [
      "rds:CreateDBInstance",
      "rds:ModifyDBInstance",
      "rds:DeleteDBInstance",
      "rds:DescribeDBInstances",
      "rds:CreateDBSubnetGroup",
      "rds:DeleteDBSubnetGroup",
      "rds:ModifyDBSubnetGroup",
      "rds:DescribeDBSubnetGroups",
      "rds:CreateDBParameterGroup",
      "rds:DeleteDBParameterGroup",
      "rds:ModifyDBParameterGroup",
      "rds:DescribeDBParameters",
      "rds:DescribeDBParameterGroups",
      "rds:AddTagsToResource",
      "rds:RemoveTagsFromResource",
      "rds:ListTagsForResource",
    ]
    resources = ["*"]
  }

  statement {
    sid = "ElastiCache"
    actions = [
      "elasticache:CreateCacheSubnetGroup",
      "elasticache:DeleteCacheSubnetGroup",
      "elasticache:ModifyCacheSubnetGroup",
      "elasticache:DescribeCacheSubnetGroups",
      "elasticache:CreateServerlessCache",
      "elasticache:ModifyServerlessCache",
      "elasticache:DeleteServerlessCache",
      "elasticache:DescribeServerlessCaches",
      "elasticache:CreateServerlessCacheSnapshot",
      "elasticache:DeleteServerlessCacheSnapshot",
      "elasticache:DescribeServerlessCacheSnapshots",
      "elasticache:CreateSecurityGroup",
      "elasticache:DeleteSecurityGroup",
      "elasticache:AuthorizeCacheSecurityGroupIngress",
      "elasticache:RevokeCacheSecurityGroupIngress",
      "elasticache:DescribeSecurityGroups",
      "elasticache:AddTagsToResource",
      "elasticache:RemoveTagsFromResource",
      "elasticache:ListTagsForResource",
    ]
    resources = ["*"]
  }

  # MSK Serverless replaced by self-hosted Redpanda on ECS Fargate.
  # kafka:* permissions removed — Redpanda uses ECS + EFS + Cloud Map instead.

  statement {
    sid = "EFS"
    actions = [
      "elasticfilesystem:CreateFileSystem",
      "elasticfilesystem:DescribeFileSystems",
      "elasticfilesystem:CreateMountTarget",
      "elasticfilesystem:DescribeMountTargets",
      "elasticfilesystem:CreateAccessPoint",
      "elasticfilesystem:DescribeAccessPoints",
      "elasticfilesystem:DeleteFileSystem",
      "elasticfilesystem:DeleteMountTarget",
      "elasticfilesystem:DeleteAccessPoint",
    ]
    resources = ["*"]
  }

  statement {
    sid = "LoadBalancing"
    actions = [
      "elasticloadbalancing:CreateLoadBalancer",
      "elasticloadbalancing:DeleteLoadBalancer",
      "elasticloadbalancing:DescribeLoadBalancers",
      "elasticloadbalancing:ModifyLoadBalancerAttributes",
      "elasticloadbalancing:CreateTargetGroup",
      "elasticloadbalancing:DeleteTargetGroup",
      "elasticloadbalancing:DescribeTargetGroups",
      "elasticloadbalancing:ModifyTargetGroup",
      "elasticloadbalancing:ModifyTargetGroupAttributes",
      "elasticloadbalancing:RegisterTargets",
      "elasticloadbalancing:DeregisterTargets",
      "elasticloadbalancing:DescribeTargetHealth",
      "elasticloadbalancing:CreateListener",
      "elasticloadbalancing:DeleteListener",
      "elasticloadbalancing:DescribeListeners",
      "elasticloadbalancing:ModifyListener",
      "elasticloadbalancing:CreateRule",
      "elasticloadbalancing:DeleteRule",
      "elasticloadbalancing:DescribeRules",
      "elasticloadbalancing:ModifyRule",
      "elasticloadbalancing:AddTags",
      "elasticloadbalancing:RemoveTags",
      "elasticloadbalancing:DescribeTags",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "deployer_compute_and_data" {
  name        = "${var.project_name}-deployer-compute-data"
  description = "Deployer: ECS, RDS, ElastiCache, EFS, ALB."
  policy      = data.aws_iam_policy_document.deployer_compute_and_data.json
}

resource "aws_iam_role_policy_attachment" "deployer_compute_and_data" {
  role       = aws_iam_role.github_deployer.name
  policy_arn = aws_iam_policy.deployer_compute_and_data.arn
}

# ── Policy 3/3: platform services ───────────────────────────────────────────

data "aws_iam_policy_document" "deployer_platform" {
  statement {
    sid = "Route53"
    actions = [
      "route53:ChangeResourceRecordSets",
      "route53:GetChange",
      "route53:List*",
      "route53:GetHostedZone",
    ]
    resources = ["*"]
  }

  statement {
    sid = "ACM"
    actions = [
      "acm:RequestCertificate",
      "acm:DescribeCertificate",
      "acm:DeleteCertificate",
      "acm:ListCertificates",
      "acm:AddTagsToCertificate",
      "acm:RemoveTagsFromCertificate",
    ]
    resources = ["*"]
  }

  statement {
    sid = "SecretsManager"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:UpdateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
      "secretsmanager:PutSecretValue",
    ]
    resources = ["*"]
  }

  statement {
    sid = "ServiceIAM"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:PassRole",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:ListPolicyVersions",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = ["*"]
  }

  statement {
    sid = "ECRPull"
    actions = [
      "ecr:GetAuthorizationToken",
    ]
    resources = ["*"]
  }

  statement {
    sid = "ECRImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:DescribeRepositories",
      "ecr:CreateRepository",
      "ecr:DeleteRepository",
      "ecr:PutLifecyclePolicy",
      "ecr:SetRepositoryPolicy",
      "ecr:TagResource",
    ]
    resources = ["*"]
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:DescribeLogGroups",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
      "logs:TagLogGroup",
    ]
    resources = ["*"]
  }

  statement {
    sid = "CloudWatchAlarms"
    actions = [
      "cloudwatch:PutMetricAlarm",
      "cloudwatch:DeleteAlarms",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:PutDashboard",
      "cloudwatch:DeleteDashboards",
      "cloudwatch:GetDashboard",
      "cloudwatch:ListDashboards",
    ]
    resources = ["*"]
  }

  statement {
    sid = "SNS"
    actions = [
      "sns:CreateTopic",
      "sns:DeleteTopic",
      "sns:GetTopicAttributes",
      "sns:SetTopicAttributes",
      "sns:Subscribe",
      "sns:Unsubscribe",
      "sns:ListSubscriptionsByTopic",
      "sns:TagResource",
    ]
    resources = ["*"]
  }

  statement {
    sid = "ServiceDiscovery"
    actions = [
      "servicediscovery:CreatePrivateDnsNamespace",
      "servicediscovery:DeleteNamespace",
      "servicediscovery:GetNamespace",
      "servicediscovery:CreateService",
      "servicediscovery:DeleteService",
      "servicediscovery:GetService",
      "servicediscovery:UpdateService",
      "servicediscovery:TagResource",
    ]
    resources = ["*"]
  }

  statement {
    sid = "KMS"
    actions = [
      "kms:CreateKey",
      "kms:DescribeKey",
      "kms:EnableKeyRotation",
      "kms:DisableKey",
      "kms:ScheduleKeyDeletion",
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:TagResource",
      "kms:UntagResource",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "deployer_platform" {
  name        = "${var.project_name}-deployer-platform"
  description = "Deployer: Route53, ACM, Secrets Manager, IAM, ECR, CloudWatch, SNS, Cloud Map, KMS."
  policy      = data.aws_iam_policy_document.deployer_platform.json
}

resource "aws_iam_role_policy_attachment" "deployer_platform" {
  role       = aws_iam_role.github_deployer.name
  policy_arn = aws_iam_policy.deployer_platform.arn
}

# ── 5. DNS hosted zone (delegate NS at registrar) ───────────────────────────

resource "aws_route53_zone" "root" {
  name = var.domain_name
}
