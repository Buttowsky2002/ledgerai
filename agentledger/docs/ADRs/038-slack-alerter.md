# ADR-038 — Slack alerting on budget thresholds + critical risk events

**Date:** 2026-06-22
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 6 (CLAUDE.md — "Slack alerting on budget thresholds and critical risk events"); the data-plane dependency-minimalism rule (rule 12); no-secrets-in-repo (rule 1); parameterized queries only (rule 4); fail-safely / nothing-fails-silently (rule 11). Second of the P6-F operability PRs (follows ADR-037).

---

## Context

P6 calls for operational alerting: notify a team channel when an agent/team/tenant
crosses a configured budget threshold, and when a **critical (severity=high)** risk
event is raised. The data already exists — budget definitions in Postgres
(`budgets.alert_pcts`), spend in the ClickHouse rollups (`spend_daily`,
`spend_hourly_by_key`), and governed risk events in `risk_events` — but nothing
pushed it anywhere. The dashboards are pull-only; an unattended budget overrun or a
disallowed-tool event could sit unseen for hours.

## Decision

Add a standalone Go worker `services/workers/cmd/slack-alerter` (+ `internal/slackalert`)
that polls on a fixed interval and posts to a Slack incoming webhook.

- **Two detectors per pass.** (a) For each budget, current spend for its scope since
  the start of the month is read from ClickHouse and compared to `amount_usd`; the
  highest crossed `alert_pcts` threshold fires. (b) `risk_events FINAL` filtered to
  `severity='high'` since a high-water mark fires one alert per new event.
- **In-memory dedupe, re-armed from "now" on restart.** Budget alerts dedupe on
  `(budget_id, YYYY-MM)` storing the highest pct already sent, so each threshold
  (50/80/100…) fires at most once per month and a higher crossing still alerts.
  Risk events dedupe via a `detected_at` high-water mark. The mark **initializes to
  process start**, so a restart does **not** replay the historical backlog — we
  accept missing events during downtime over spamming the channel on every redeploy.
  No new table or migration; state is intentionally ephemeral.
- **Webhook URL is an env-var NAME only (`AGENTLEDGER_SLACK_WEBHOOK_URL`), rule 1.**
  Unset ⇒ `Enabled()` is false and every pass is a no-op (the worker still serves
  health/metrics). The optional alerter never breaks a deployment that hasn't
  configured it — same "observe everywhere, act where configured" posture as the
  gateway's tool governance.
- **Stdlib net/http for both ClickHouse and Slack (rule 12);** `lib/pq` for Postgres
  — the repo's already-adopted Go PG driver (gateway `config_pg.go`, connectors
  `store.go`), here added to the workers module for the first time. No Slack SDK.
- **Cross-tenant reads, no per-request RLS.** The alerter needs every tenant's
  budgets and spend, so it connects with a role that bypasses RLS — the same
  convention as the gateway's config reads — rather than binding a tenant per query.
  All scope/date values are bound as ClickHouse query parameters (rule 4); no SQL is
  built from interpolated user data.
- **Operability:** `/healthz`, `/readyz` (pings both ClickHouse and Postgres), and a
  hand-rolled stdlib `/metrics` (`slack_alert_runs_total`, `slack_alerts_sent_total`,
  `slack_alerts_failed_total`, `slack_budget_breaches_detected_total`,
  `slack_risk_events_detected_total`). Slack POSTs retry transient failures with
  backoff; a final failure increments `slack_alerts_failed_total` and logs — nothing
  fails silently (rule 11).

## Consequences

- **Positive:** budget overruns and critical risk events reach a channel within one
  poll interval; no new dependency in the data plane; no schema change; the worker is
  safe to deploy unconfigured (no-op until a webhook is set).
- **Trade-offs / accepted:** dedupe state is per-process and lost on restart — by
  design we drop in-flight risk events during downtime rather than replay a backlog,
  and budget re-alerts could theoretically double-fire across two replicas (the
  worker is intended to run as a single replica; horizontal scale would need shared
  state, deferred). Spend is read from the daily/hourly rollups, so detection lags
  the rollup cadence. The month-boundary reset is calendar-month only (matches the
  `monthly` budget period; quarterly budgets still alert but reset monthly — refined
  later if needed).
- **Verification:** `internal/slackalert` unit tests cover threshold selection
  (`highestCrossed`), budget alert-once-then-dedupe with a later higher crossing,
  risk-event high-water-mark dedupe, the disabled no-op path, and failed-post metric
  accounting; the workers suite stays green under `-race`. A new `slack-alerter`
  service is wired into `docker-compose.yml` (Postgres + ClickHouse healthchecks).
