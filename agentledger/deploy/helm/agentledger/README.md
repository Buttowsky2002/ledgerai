# AgentLedger Helm chart

Deploys the AgentLedger **application workloads** to Kubernetes:

| Service | Port | Kind | Notes |
|---------|------|------|-------|
| `gateway` | 8080 | web | Optional enforcement tier (proxy + DLP + budgets). |
| `api` | 8094 | web | Control-plane API (NestJS). |
| `collector` | 8090 | web | Ingest intake → Redpanda. |
| `litellm-adapter` | 8097 | web | LiteLLM spend-log → collector. |
| `ch-insert` | 8091 | worker | Redpanda → ClickHouse. |
| `reconcile` | 8093 | worker | Observed vs billed cost. |
| `risk-engine` | 8099 | worker | Tool governance → risk events. |
| `risk-enrichment` | 8100 | worker | Opt-in semantic risk tier. |
| `slack-alerter` | 8101 | worker | Budget/risk alerts → Slack. |
| `connector-sync` | 8092 | worker | Provider billing connectors. |
| `outcome-sync` | 8095 | worker | GitHub/Jira/Zendesk outcomes. |
| `attribution` | 8096 | worker | Outcome→run matcher (disabled by default). |

## What this chart does NOT deploy

Stateful infrastructure — **PostgreSQL, ClickHouse, Redpanda/Kafka, Redis** — is
**not** bundled. The chart is cloud-agnostic and assumes these are provisioned as
managed services (see [`deploy/terraform`](../../terraform)) and reached via
`externalServices` + an operator-supplied Secret. This keeps stateful data on
managed, backed-up, least-privilege backends (CLAUDE.md rules 7 & 9) rather than
in-cluster StatefulSets. See [ADR-039](../../../docs/ADRs/039-helm-terraform-deploy.md).

## Prerequisites

1. A Kubernetes cluster (1.25+) and `helm` 3.x.
2. Managed Postgres, ClickHouse, Redpanda/Kafka, and (optionally) Redis reachable
   from the cluster; migrations in `deploy/postgres` + `deploy/clickhouse` applied.
3. A Secret with the sensitive env values (the chart holds none — rule 1):

   ```bash
   kubectl -n agentledger create secret generic agentledger-secrets \
     --from-literal=AGENTLEDGER_PG_DSN='postgres://USER:PASS@HOST:5432/agentledger?sslmode=require' \
     --from-literal=AGENTLEDGER_JWT_SECRET='...' \
     --from-literal=OPENAI_API_KEY='...' \
     --from-literal=ANTHROPIC_API_KEY='...' \
     --from-literal=AGENTLEDGER_SLACK_WEBHOOK_URL='...' \
     --from-literal=GITHUB_TOKEN='...' \
     --from-literal=AGENTLEDGER_REDIS_PASSWORD='...'
   ```

   (See [`secret.example.yaml`](secret.example.yaml). Prefer External Secrets /
   Vault / cloud KMS over a static manifest.)

4. ConfigMaps for the gateway price book and collector event schema (single
   source of truth stays in the repo):

   ```bash
   kubectl -n agentledger create configmap agentledger-pricebook \
     --from-file=pricebook.json=pricing/pricebook.json
   kubectl -n agentledger create configmap agentledger-event-schemas \
     --from-file=llm_call.schema.json=schemas/events/llm_call.schema.json
   ```

## Install

```bash
helm upgrade --install agentledger deploy/helm/agentledger \
  --namespace agentledger --create-namespace \
  --set secrets.existingSecret=agentledger-secrets \
  --set externalServices.clickhouse.url=http://clickhouse.data.svc:8123 \
  --set externalServices.redpanda.brokers=redpanda.data.svc:9092 \
  --set externalServices.redis.addr=redis.data.svc:6379 \
  --set image.tag=0.1.0
```

## Configuration

See [`values.yaml`](values.yaml) for the full set. Highlights:

- **`image.*`** — registry/repository/tag/pullPolicy. Each service's image
  defaults to `{registry}/{repository}-{serviceName}:{tag}`.
- **`externalServices.*`** — non-secret coordinates for managed infra.
- **`secrets.existingSecret`** — name of the Secret above.
- **`services.<name>`** — per-service `enabled`, `replicas`, `port`, `env`,
  `secretEnv`, `resources`, `readinessPath`, image override.
- **`gateway.config`** — the gateway's `config.json` (rendered to a ConfigMap).
- **`ingress.enabled`** / **`serviceMonitor.enabled`** — off by default.

### Security posture

- Pods run as non-root (uid 65532, distroless), read-only root FS, all
  capabilities dropped, `RuntimeDefault` seccomp, no service-account token mount.
- No secret values live in the chart; everything sensitive is referenced from
  `secrets.existingSecret` by env-var name (rule 1).
- TLS termination is expected at the Ingress / managed-DB layer (rule 9).

## Validate locally

```bash
make helm-lint     # helm lint + helm template (runs in a helm container)
```
