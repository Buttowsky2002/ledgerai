# BadgerIQ Terraform — infrastructure stub

> **Status: intentional stub.** This directory defines the *shape* of the managed
> infrastructure BadgerIQ expects, but contains **no live provider resources**.
> BadgerIQ is cloud-agnostic; provisioning is deliberately deferred to the
> operator's own platform (EKS/GKE/AKS + RDS/Cloud SQL, ClickHouse Cloud, MSK/
> Redpanda Cloud, ElastiCache/Memorystore). See
> [ADR-039](../../docs/ADRs/039-helm-terraform-deploy.md) for why.

## What the Helm chart needs from infrastructure

The chart (`deploy/helm/agentledger`) deploys **application workloads only** and
expects these to already exist and be reachable from the cluster:

| Component | Purpose | Surfaced to the chart as |
|-----------|---------|--------------------------|
| Kubernetes cluster | Runs the workloads | `kubeconfig` / context |
| PostgreSQL 16 | Control plane (RLS-enabled) | `BADGERIQ_PG_DSN` (Secret) |
| ClickHouse | Analytics store | `externalServices.clickhouse.url` |
| Redpanda / Kafka | Event bus (`events.raw`) | `externalServices.redpanda.brokers` |
| Redis (optional) | Gateway budget store | `externalServices.redis.addr` |

## Intended usage (once implemented)

```bash
terraform init
terraform plan  -var-file=env/prod.tfvars
terraform apply -var-file=env/prod.tfvars
# then feed the outputs into the Helm release (see ../helm/agentledger/README.md)
```

The variables and outputs here are real and stable; the resource blocks in
`main.tf` are commented module placeholders to be filled per target cloud. Wiring
a concrete cloud is its own ADR + PR.
