output "aws_account_id" {
  description = "AWS account ID where bootstrap resources were created."
  value       = data.aws_caller_identity.current.account_id
}

output "aws_region" {
  description = "AWS region for bootstrap resources."
  value       = data.aws_region.current.name
}

output "tfstate_bucket_name" {
  description = "S3 bucket for Terraform remote state (main stack)."
  value       = aws_s3_bucket.tfstate.id
}

output "tfstate_lock_table_name" {
  description = "DynamoDB table for Terraform state locking."
  value       = aws_dynamodb_table.tfstate_lock.name
}

output "github_deployer_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC (tag releases only)."
  value       = aws_iam_role.github_deployer.arn
}

output "route53_zone_id" {
  description = "Route 53 hosted zone ID for the root domain."
  value       = aws_route53_zone.root.zone_id
}

output "route53_name_servers" {
  description = "NS records to configure at your domain registrar."
  value       = aws_route53_zone.root.name_servers
}

output "backend_config" {
  description = "Backend block values for the main stack after state migration."
  value = {
    bucket         = aws_s3_bucket.tfstate.id
    key            = "main/terraform.tfstate"
    region         = data.aws_region.current.name
    dynamodb_table = aws_dynamodb_table.tfstate_lock.name
    encrypt        = true
  }
}
