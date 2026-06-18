# ADR-016 — Outcome-Connector Framework + GitHub Connector

**Date:** 2026-06-17
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 4 (CLAUDE_CODE_BUILD_SPEC.md §3); ADR-007 (cost-connector framework)

---

## Context

Phase 4 (the ROI engine) needs business **outcomes** (merged PRs, resolved tickets) pulled
from GitHub/Jira/Zendesk into the ClickHouse `outcomes` table, where the attribution matcher
(task 3) correlates them to `agent_runs` and `v_unit_economics` turns them into cost-per-outcome.
This ADR covers **task 1**: the outcome-connector foundation + the first connector (GitHub).

The Phase 2 cost-connector framework (ADR-007) already provides cursor-based incremental sync,
per-connector rate limiting, retries with jitter, and Postgres-persisted state — but its
`Record`/`Page`/`Connector`/`ClickHouseSink` are hard-wired to `provider_costs`, and `Syncer`
is typed to them.

## Decision

### A parallel outcome path; the cost path is untouched

Rather than refactor the shipped, tested cost connectors, add a parallel set of types in the
same `connector` package that **reuse the generic helpers** (`PGStore`, `RateLimiter`,
`Retrier`, the `connectors` table):

- `OutcomeRecord` (the `outcomes` columns), `OutcomePage`, `OutcomeConnector`, `OutcomeSink`.
- `OutcomeSyncer` — a mirror of `Syncer` with the identical crash-safe ordering (**write the
  page, then persist the cursor**; a crash re-fetches ≤1 page and the `outcomes`
  ReplacingMergeTree collapses the duplicate) — stamping `tenant_id` and defaulting
  `source_system` to the connector kind.
- `ClickHouseOutcomeSink` — mirror of `ClickHouseSink`, writing `outcomes` via HTTP
  `JSONEachRow` (stdlib, no CH driver).
- A separate `cmd/outcome-sync` binary registers outcome connectors; it shares the
  `connectors` table and **skips** non-outcome kinds (the cost `connector-sync` skips outcome
  kinds symmetrically). The Dockerfile is parameterized (`ARG CMD`) to build either binary.

Idempotency hinges on a **stable `outcome_id`** (e.g. `github:owner/repo#42`), so re-scans and
replays collapse under the ReplacingMergeTree key `(tenant_id, ts, outcome_id)`.

### GitHub connector

Stdlib HTTP against `api.github.com/repos/{repo}/pulls` (closed, sorted by `updated` desc,
paginated) — no SDK dependency, matching Bedrock/Vertex. Token from a config **env-var name**
(`token_env`, rule 1). Emits merged PRs as `OutcomeRecord{outcome_type:"pr_merged"}` with
`run_id`/`attribution_confidence`/`business_value_usd` left zero — the matcher (task 3) fills
attribution, ROI templates (task 4) fill value. The page cursor resets on completion so each
pass re-scans a `lookback_days` window; the stable `outcome_id` keeps that idempotent.

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| Generalize `Record`/`Sink` and migrate the cost connectors | Changes merged/tested code; the chosen parallel path leaves it untouched (per the agreed low-risk approach). |
| Ingest outcomes via the SDK/collector path | That path serves app-instrumented outcomes; external systems (GitHub/Jira/Zendesk) need cursor-based pull — exactly what the framework gives. |
| Connector computes attribution/value | Attribution needs run correlation (the matcher's job) and value needs tenant ROI templates; the connector emits raw outcomes only. |
| Fold outcome sync into `connector-sync` | `Syncer` is Record-typed; a separate `OutcomeSyncer` + `outcome-sync` binary is cleaner and matches "one cmd per worker". |

## Consequences

- **Positive**: Outcome connectors get incrementality, crash-safety, idempotency, pacing, and
  retries for free; importers implement only `Fetch`. The cost path is byte-for-byte unchanged.
- **Negative / scope**: Some logic (the ~40-line syncer loop, the sink) is duplicated rather
  than generified — a deliberate trade for not touching shipped code. Jira/Zendesk (task 2),
  attribution (task 3), and value formulas (task 4) are still to come; GitHub emits
  `attribution_confidence = 0` until then.
- **Operational**: a new `outcome-sync` service + `:8095` admin port; GitHub needs a PAT
  (env-var name in `connectors.config`). Live GitHub pull is verified via a recorded fixture
  (no token in CI); the sink→`outcomes` write + dedup is verified against a live ClickHouse.
