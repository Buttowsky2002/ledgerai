# ADR-039 — Helm chart + Terraform stub for deployment

**Date:** 2026-06-22
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 6 (CLAUDE.md — "Helm + Terraform"); the target layout's `deploy/helm/` + `deploy/terraform/` (CLAUDE.md §2); no-secrets-in-repo (rule 1); least-privilege + non-root containers (rule 7); TLS/encrypt-at-rest (rule 9). Last of the P6-F operability PRs (follows ADR-037, ADR-038).

---

## Context

P6 calls for a deployable packaging of BadgerIQ beyond `docker-compose` (which
is dev-only). The repo had no Kubernetes manifests, Helm chart, or Terraform.
BadgerIQ is sold as software the customer runs on their own stack, so the
packaging must be **cloud-agnostic** — it cannot assume a particular managed
database, message bus, or cloud.

## Decision

Ship a single **Helm chart** (`deploy/helm/agentledger`) that deploys the
**application workloads only**, plus a **Terraform stub** (`deploy/terraform`)
that documents the infrastructure contract without binding a cloud.

- **App workloads, not infra.** The chart deploys the 11 BadgerIQ services
  (gateway, api, collector, litellm-adapter, ch-insert, reconcile, risk-engine,
  risk-enrichment, slack-alerter, connector-sync, outcome-sync; attribution
  ships disabled). It does **not** bundle PostgreSQL, ClickHouse, Redpanda, or
  Redis — those are referenced as external, operator-provisioned managed services
  via `externalServices` (non-secret coordinates) + a Secret. This keeps stateful,
  consistency-critical data on backed-up, least-privilege managed backends (rules
  7/9) instead of in-cluster StatefulSets, and is what "cloud-agnostic" demands.
- **Generic templating.** One `deployment.yaml` and one `service.yaml` range over
  a `services` map in `values.yaml`, so all 11 workloads stay DRY and a new
  service is a values entry, not a new template. The gateway (config + price book)
  and collector (event schema) are the only special-cased file mounts.
- **No secrets in the chart (rule 1).** Sensitive env values come from an
  operator-supplied `secrets.existingSecret`, referenced by env-var NAME only;
  `secret.example.yaml` carries non-realistic placeholders and is `.helmignore`d
  from packaging. The price book and event-schema ConfigMaps are operator-created
  from the repo's single sources of truth (`pricing/`, `schemas/events/`) rather
  than copied into the chart (avoids drift). Gateway `virtual_keys`, DLP policies,
  and the tool allowlist are loaded from Postgres at runtime (ADR-032), so they
  never appear in chart config either.
- **Hardened pods (rule 7).** Non-root (uid 65532, distroless), read-only root FS
  with an `emptyDir` `/tmp`, all capabilities dropped, `RuntimeDefault` seccomp,
  no service-account token mount, resource requests/limits and liveness
  (`/healthz`) + readiness (`/readyz`, or `/healthz` for the three services that
  expose only liveness) probes on every workload.
- **Terraform = documented stub.** `deploy/terraform` declares the real, stable
  `variables`/`outputs` describing the infra contract (Postgres 16 w/ RLS,
  ClickHouse, Kafka/Redpanda, optional Redis) but **no live resources** — module
  blocks are commented placeholders to be wired per target cloud in a dedicated
  follow-up. Connection strings are marked `sensitive` and meant for a secret
  manager, not plaintext state (rule 1).
- **Validation.** `make helm-lint` runs `helm lint` + `helm template` (local helm
  or a `alpine/helm` container, mirroring the Go-in-Docker convention). Not wired
  as a required CI check yet — like the k6 load test (ADR-037), deploy tooling is
  validated out of band.

## Consequences

- **Positive:** BadgerIQ is installable on any conformant cluster with one
  `helm upgrade --install`; infra stays managed and cloud-portable; the chart
  carries zero secret material; adding/disabling a service is a values edit.
- **Trade-offs / accepted:** operators must provision the data stores and create
  the Secret + two ConfigMaps before first install (documented in chart README +
  `NOTES.txt`); the Terraform is a contract, not a turnkey provisioner — wiring a
  concrete cloud is future work; `helm-lint` isn't a blocking CI gate. The gateway
  `events` sink defaults to the direct-ClickHouse `http` path, which operators
  running the Redpanda pipeline will override.
- **Verification:** `helm lint` clean (only the cosmetic "icon recommended"
  info); `helm template` renders 11 Deployments + 11 Services + gateway ConfigMap
  + ServiceAccount, with Ingress and ServiceMonitor when enabled; the rendered
  gateway `config.json` parses as valid JSON and contains no `virtual_keys`; every
  Deployment carries resources, both probes, and a non-root pod security context.
