# ADR-008 — Cloud Cost Connectors (Bedrock, Vertex)

**Date:** 2026-06-16
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 2 (CLAUDE_CODE_BUILD_SPEC.md §3); ADR-007

---

## Context

Phase 2 needs importers for the two cloud-marketplace LLM routes — AWS Bedrock
and GCP Vertex — alongside the OpenAI and Anthropic API importers. Unlike the
LLM vendors' simple API-key endpoints, cloud spend comes from billing systems
with heavier auth (AWS SigV4, GCP OAuth2) and different data models.

The constraint: stay testable (mock-HTTP, no live cloud calls in CI) and avoid
dragging the large cloud SDK dependency trees into the connectors module.

---

## Decision

### Bedrock → AWS Cost Explorer `GetCostAndUsage`, hand-rolled SigV4

Actual Bedrock spend lives in AWS Cost Explorer. The connector POSTs
`GetCostAndUsage` (DAILY granularity, `SERVICE = "Amazon Bedrock"` filter,
grouped by `USAGE_TYPE`) and signs with **a hand-rolled SigV4 signer** rather
than pulling `aws-sdk-go-v2`.

Rationale: the request is a single signed POST; the SDK's value (typed clients,
retries, pagination) is already provided by our framework, and SigV4 is a
standard, deterministic algorithm. The signer is **validated against AWS's
published Signature Version 4 test vector** (`TestSigV4MatchesAWSVector`), so we
get correctness without a megabyte of transitive dependencies. Credentials come
from env vars named in connector config (`AWS_ACCESS_KEY_ID`, etc.), with STS
session-token support.

| Alternative | Rejected because |
|---|---|
| `aws-sdk-go-v2/service/costexplorer` | Large dependency tree for one signed POST; SDK retries/pagination duplicate the framework. |
| AWS CUR (Cost and Usage Report) in S3 | Requires S3 + Athena/Parquet plumbing; Cost Explorer is the simpler daily-grain source for a pilot. |

### Vertex → BigQuery billing export via `jobs.query`, bearer token

GCP's Cloud Billing **API** exposes the price catalog, **not** your spend — actual
spend is only available through the **BigQuery billing export**. The connector
issues a `jobs.query` REST call against the export table, grouped by day + SKU,
filtered to the Vertex service. Auth is an OAuth2 bearer token read from an env
var (supplied out-of-band by workload identity / `gcloud auth
print-access-token`); no GCP SDK dependency.

**Injection safety (rule 4):** the date and service filters are bound as **NAMED
query parameters**, never concatenated. The export table name comes from operator
config and is **format-validated** against `^[A-Za-z0-9_.:-]+$` before being
backtick-quoted — table identifiers can't be parameterized, so validation is the
guard (the same pattern as the ch-insert table allowlist). A test feeds a
`DROP TABLE` table name and asserts rejection.

| Alternative | Rejected because |
|---|---|
| Cloud Billing API | Returns pricing, not actual spend — wrong data source. |
| `cloud.google.com/go/bigquery` SDK | Large dependency; one parameterized query is a plain REST POST. |
| Service-account JSON key in config | Secrets in config violate rule 1; a short-lived bearer token from workload identity is the secure path. |

### Normalization quirks

- Both advance a **day watermark** and re-import the current (still-accruing) day
  each run; `provider_costs` ReplacingMergeTree collapses the overlap (per ADR-007).
- **Provider labels** are distinct from the gateway's (`aws_bedrock`,
  `gcp_vertex`) since these are marketplace routes; model attribution is
  best-effort (Bedrock parses the model from the usage type; Vertex attributes by
  SKU, as GCP billing has no model dimension).
- Vertex uses a single `jobs.query` with a large `maxResults` (grouped daily
  rows are small); `getQueryResults` paging is a documented future enhancement.

---

## Consequences

- **Positive**: Both cloud providers import with **zero cloud-SDK dependencies** —
  connectors module stays `lib/pq`-only — and are fully mock-HTTP testable.
- **Positive**: SigV4 correctness is pinned to AWS's own test vector; SQL is
  parameterized + table-validated.
- **Negative / scope**: GCP auth relies on an externally-supplied bearer token
  (no in-process token refresh yet); Vertex results aren't paged. Both are
  acceptable for the pilot and documented.
- **Negative**: Model-level reconciliation is coarser for cloud providers
  (usage-type / SKU based), so drift is most precise at the provider/day level
  for Bedrock and Vertex.
