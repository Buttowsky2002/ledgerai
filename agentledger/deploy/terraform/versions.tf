terraform {
  required_version = "~> 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    # Populated via -backend-config or backend.hcl after Phase 1 bootstrap.
    # bucket         = "badgeriq-tfstate-<account_id>-us-east-1"
    # key            = "main/terraform.tfstate"
    # region         = "us-east-1"
    # dynamodb_table = "badgeriq-tfstate-lock"
    # encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}
