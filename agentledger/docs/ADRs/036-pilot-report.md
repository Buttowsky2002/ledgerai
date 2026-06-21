# ADR-036 — 30-day pilot report

**Date:** 2026-06-21
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 6 (CLAUDE.md — "30-day pilot report generator"); ADR-013 (analytics over ClickHouse MVs); ADR-026 (risk-adjusted ROI engine / `v_roi`); ADR-024 (outcome graph). Pairs with ADR-035 (FOCUS export) as the second of the P6-E finance-facing outputs.

---

## Context

After a trial, AgentLedger has to *prove value* to the FinOps lead/CISO who ran
it — but there was no single artifact summarizing what the agents cost, returned,
and risked over the pilot window. CLAUDE.md mandates a "30-day pilot report
generator." The acceptance bar (carried from Phase 4) is that a headline figure
**traces fully back to source events**.

## Decision

Add `GET /v1/analytics/pilot-report?from=&to=&format=json|md` to the analytics
module (`@Roles('viewer')`, default window = last 30 days). One service method
aggregates the views that already exist into a structured report; **each section
records the `source` view it came from**, satisfying the traceability bar.

Sections and sources:
- **Spend** ← `spend_daily` (total cost, calls, tokens, blocked/errored, by provider).
- **Top agents** ← `spend_hourly_by_key` (top 5 by cost).
- **Unit economics** ← `outcomes` + `agent_runs` (outcomes, AI cost, business value,
  cost-per-outcome, net value) at the headline confidence bar (≥ 0.5).
- **Risk-adjusted ROI** ← `v_roi` (value, fully-loaded cost, expected + risk-adjusted
  ROI, the [low, high] band) at confidence ≥ 0.5.
- **Governance posture** ← `risk_daily` (events by severity, DLP blocks, high-severity count).

All sub-queries are tenant-scoped via `queryScoped` (tenant from the JWT, never
request input — rule 3) and run concurrently. `report.renderer.ts` owns the
report shape (`PilotReport`) and a **hand-rolled Markdown renderer** (no templating
dependency, rule 12) for the email/PDF precursor; `format=md` returns
`text/markdown`, otherwise JSON.

## Consequences

- **Positive:** a one-call, board-ready trial summary; every figure cites its
  source view so it's auditable back to events. No new storage, no migration, no
  dependency — purely a read over existing MVs/views, reusing the FOCUS-export
  audit-free read pattern (the report is a derived summary, not a bulk egress).
- **Trade-offs / accepted:** the report is a point-in-time snapshot, not a live
  dashboard; the headline confidence bar is fixed at 0.5 (matching the ROI engine's
  default) rather than a query param, to keep "headline" unambiguous; the
  governance section reports DLP/severity counts from `risk_daily`, not per-event
  detail (the CISO view already serves drill-down).
- **Verification:** unit tests for the Markdown renderer (sections, source
  citations, currency/ROI formatting, empty-agents fallback); api e2e seeds an
  end-to-end fixture (calls → run → an attributed high-confidence outcome) and
  asserts the spend/unit-economics/ROI/governance sections populate, the Markdown
  renders, an unrelated tenant gets an empty report (isolation), and an invalid
  format is rejected.
