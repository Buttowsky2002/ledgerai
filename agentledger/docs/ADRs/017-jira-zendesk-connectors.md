# ADR-017 — Jira + Zendesk Outcome Connectors

**Date:** 2026-06-18
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 4 (CLAUDE_CODE_BUILD_SPEC.md §3); ADR-016 (outcome-connector framework + GitHub)

---

## Context

ADR-016 shipped the outcome-connector framework and the first importer (GitHub). Phase 4 task 2
adds the next two — **Jira** and **Zendesk** — so the attribution matcher (task 3) and
`v_unit_economics` have ticket/issue outcomes to correlate against `agent_runs`. Both are
implemented by mirroring `github.go`: stdlib HTTP (no SDK), env-var-name credentials (rule 1),
a stable `outcome_id`, and a `lookback_days` window that resets the cursor on completion so each
pass re-scans idempotently under the `outcomes` ReplacingMergeTree. No framework changes; the
cost path is untouched.

## Decision

### Auth: HTTP Basic `base64(email:token)`

Unlike GitHub (Bearer PAT), Jira Cloud and Zendesk authenticate API-token requests with HTTP
Basic. Both connectors therefore take **two** env-var names — `email_env` and `token_env` — and
send `Authorization: Basic base64(email:token)`. Per-connector divergence (Basic for one, Bearer
for the other) was rejected in favor of a single uniform auth model across the two new connectors.

> **Zendesk simplification:** Zendesk's API-*token* form technically expects the username
> `email/token` (not `email`). We keep the uniform `email:token` model, which works with
> password / OAuth-token Basic auth; switching to the `/token` suffix is a one-line change in
> `zendesk.go` if a deployment uses API-token auth specifically.

### outcome_type mapping

| Connector | Source endpoint | Selected records | `outcome_type` | `outcome_id` |
|---|---|---|---|---|
| `jira` | `GET /rest/api/3/search` (JQL `statusCategory = Done`, sorted `updated DESC`) | resolved issues in window | `issue_closed` | `jira:{KEY}` (e.g. `jira:PROJ-12`) |
| `zendesk` | `GET /api/v2/search.json` (`type:ticket status:solved`, sorted `updated_at desc`) | solved tickets in window | `ticket_resolved` | `zendesk:{id}` |

`run_id` / `attribution_confidence` / `business_value_usd` are left zero — filled later by the
matcher (task 3) and ROI templates (task 4), exactly as GitHub does.

### Pagination

- **Jira** — offset pagination via `startAt` (cursor key `start_at`); done when
  `startAt + len(issues) >= total` or a short page.
- **Zendesk** — page pagination via `page` (cursor key `page`); done when `next_page` is null or
  a short page.

Both reset the cursor to empty on completion (mirrors GitHub's page reset → re-scan the
`lookback_days` window each pass).

### No DB migration

`connectors.kind` is free-text `TEXT`; its column comment already enumerates `jira|zendesk`. No
forward migration is required to register the new kinds.

## Consequences

- **Positive**: Two more outcome sources with incrementality, crash-safety, idempotency, pacing,
  and retries inherited from the framework; importers add only `Fetch`. The cost path and the
  GitHub connector are unchanged.
- **Negative / scope**: Auth is Basic-only and the Jira JQL is fixed to `statusCategory = Done`
  (configurable JQL deferred). The Zendesk `email/token` username nuance is a documented
  simplification.
- **Operational**: each connector needs two env vars (`email_env`, `token_env`) named in
  `connectors.config`; tests use recorded JSON fixtures via `httptest` (no live tokens in CI),
  matching `github_test.go`.
