# ADR-037 — Gateway policy-overhead metrics + load test

**Date:** 2026-06-21
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 6 (CLAUDE.md — "k6 load test proving gateway p95 < 75ms policy overhead at 1k RPS"); the performance budget in CLAUDE.md §5; the data-plane dependency-minimalism rule (rule 12). First of the P6-F operability PRs.

---

## Context

CLAUDE.md sets a hard budget: **gateway inline policy overhead p95 < 75ms at 1k
RPS**. But the gateway exposed no metrics — only `/healthz` and a budget-snapshot
`/v1/usage` — so the budget was **unmeasurable**, and there was no load test. You
can't gate on what you can't measure.

## Decision

Make policy overhead a first-class, measurable signal and ship an advisory load
test.

- **Hand-rolled Prometheus metrics (`metrics.go`), stdlib-only.** The gateway data
  plane stays dependency-free (rule 12), so — like the workers' `WritePrometheus`
  — `Metrics` is atomic counters + a fixed-bucket latency histogram rendered in the
  text exposition format, with **no prometheus client dependency**. Exposed at
  `GET /metrics`: `gateway_requests_total{status}` and the
  `gateway_policy_overhead_ms` histogram.
- **"Policy overhead" = inline time minus the upstream round-trip.** In
  `serveCanonical`, the dispatch window `[preDispatch, postDispatch]` brackets the
  upstream call; overhead = `(preDispatch − start) + (now − postDispatch)`. Early
  policy rejections (model allowlist, tool governance, budget, DLP) never reach the
  upstream, so `finishFmt` observes the whole elapsed time as overhead. This
  isolates the gateway's *own* cost from model latency — exactly what the budget
  governs.
- **k6 load test (`tests/load/gateway.k6.js`), advisory.** A constant-arrival-rate
  scenario drives ~1k RPS; with a near-zero-latency mock upstream, end-to-end p95
  ≈ overhead, and the run scrapes the authoritative `gateway_policy_overhead_ms`
  histogram in teardown. `make load` runs it locally; a `load-nightly` workflow
  (manual dispatch + nightly cron, skips when no target is configured) runs it out
  of band. It is **deliberately not a required PR check** — 1k RPS on shared CI
  runners is too noisy to gate merges on.
- **ClickHouse 50M-events/day** capacity target is documented in
  `tests/load/README.md` (drive the collector → ch-insert path, watch lag +
  `chinsert_rows_inserted_total`); a scripted harness is deferred.

## Consequences

- **Positive:** the p95 budget is now observable in prod (scrape `/metrics`) and
  enforceable in the load test; no new gateway dependency; the histogram cleanly
  separates gateway overhead from upstream latency.
- **Trade-offs / accepted:** fixed histogram buckets (1–1000ms) rather than native
  histograms; the load test needs an operator-provided mock upstream + running
  gateway (documented), so it isn't fully self-contained in CI; the 50M/day
  ClickHouse check is documented, not yet scripted. Observation adds a handful of
  atomic ops per request — negligible against the 75ms budget.
- **Verification:** Go unit tests cover histogram bucketing/render and nil-safety,
  and assert a proxied request and a DLP-blocked request are both observed with the
  right outcome class; the full gateway suite stays green under `-race`,
  golangci-lint v2.1.6 clean. The k6 thresholds (`p(95)<75`, error rate < 1%) run
  via `make load` / the nightly workflow.
