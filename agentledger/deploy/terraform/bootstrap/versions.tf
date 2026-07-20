terraform {
  required_version = "~> 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # First apply uses local state. After the S3 bucket exists, migrate:
  #   terraform init -migrate-state -backend-config=backend.hcl
  # See README.md for the full sequence.
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}
