# BadgerIQ Terraform bootstrap

One-time stack that provisions prerequisites for all other Terraform work:

| # | Resource | Purpose |
|---|----------|---------|
| 1 | S3 bucket | Remote state storage for `deploy/terraform/` (main stack) |
| 2 | DynamoDB table | State locking (`LockID` hash key) |
| 3 | IAM OIDC provider | GitHub Actions → AWS (`token.actions.githubusercontent.com`) |
| 4 | IAM role + policy | `badgeriq-github-deployer` — tag releases only (`v*.*.*`) |
| 5 | Route 53 zone | Root domain (`badgeriq.app` by default) |

This stack **must stay separate** from the main stack because it owns the state backend the main stack depends on.

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) `~> 1.9`
- AWS CLI configured with credentials that can create S3, DynamoDB, IAM, and Route 53 resources
- AWS account and `us-east-1` region (default; override with `-var aws_region=...`)

## One-time apply sequence

### Step 1 — Init with local state

The bootstrap stack starts with **local state** (no chicken-and-egg problem):

```bash
cd agentledger/deploy/terraform/bootstrap
terraform init
terraform plan
terraform apply
```

Review the plan. You should see five logical components (S3 backend, DynamoDB lock, OIDC provider, IAM deployer role, Route 53 zone) plus their supporting sub-resources (bucket encryption, lifecycle, etc.).

Save the outputs — you need them for delegation and for wiring the main stack:

```bash
terraform output route53_name_servers
terraform output github_deployer_role_arn
terraform output backend_config
```

### Step 2 — Delegate DNS

At your domain registrar, set the NS records for `badgeriq.app` (or your `domain_name`) to the `route53_name_servers` output. ACM validation and ALB DNS in later phases depend on this.

### Step 3 — Migrate bootstrap state to S3

After the bucket exists, move this stack's own state off your laptop:

Create `backend.hcl` locally (gitignored — do not commit):

```hcl
bucket         = "<tfstate_bucket_name output>"
key            = "bootstrap/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "badgeriq-tfstate-lock"
encrypt        = true
```

Add a `backend "s3" {}` block to `versions.tf` (or a `backend.tf` file), then:

```bash
terraform init -migrate-state -backend-config=backend.hcl
```

Confirm state now lives in S3:

```bash
aws s3 ls s3://badgeriq-tfstate-<account_id>-us-east-1/bootstrap/
```

### Step 4 — Wire the main stack backend

In `deploy/terraform/`, configure the same S3 bucket with a different key (`main/terraform.tfstate`). Use the `backend_config` output as a template.

## GitHub Actions OIDC

The deployer role trust policy allows **only semver tag refs**:

```
repo:Buttowsky2002/ledgerai:ref:refs/tags/v*.*.*
```

Branch pushes and PR workflows cannot assume this role. Override the repo with:

```bash
terraform apply -var github_repository=OWNER/REPO
```

### Verify OIDC (after apply)

Add a temporary workflow job (or use the Phase 5 deploy workflow once it exists):

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::<account_id>:role/badgeriq-github-deployer
      aws-region: us-east-1
  - run: aws sts get-caller-identity
```

Push a tag matching `v*.*.*` (e.g. `v0.0.1-test`) to trigger it. The identity ARN should show the assumed role.

## Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `aws_region` | `us-east-1` | AWS region |
| `domain_name` | `badgeriq.app` | Route 53 hosted zone |
| `github_repository` | `Buttowsky2002/ledgerai` | OIDC trust scope |
| `project_name` | `badgeriq` | Resource name prefix |

## IAM policy scope

`badgeriq-deployer-permissions` grants:

- Read/write on the tfstate bucket and lock table only (scoped ARNs)
- EC2/VPC create/describe for network modules
- Explicit create/update/delete/describe on ECS, RDS, ElastiCache Serverless, MSK, ALB, Route 53 records, ACM, Secrets Manager, CloudWatch, SNS, Service Discovery, KMS
- IAM role/policy management for service-linked roles Terraform creates
- ECR pull/create for container images

It does **not** grant `*:*` (full admin). If a later Terraform apply fails with `AccessDenied`, add the specific missing action to the policy in a follow-up PR rather than widening to admin.

## Gate checklist

- [ ] `terraform init && terraform plan` — clean plan, five components present
- [ ] `terraform apply` — succeeds
- [ ] NS records delegated at registrar
- [ ] Bootstrap state migrated to S3
- [ ] `aws sts get-caller-identity` from a tag-triggered workflow shows the deployer role

## Next phase

Once this gate passes, proceed to **Phase 2** — managed data infrastructure in `deploy/terraform/main.tf` (VPC, RDS, Redis, MSK, ClickHouse secret).
