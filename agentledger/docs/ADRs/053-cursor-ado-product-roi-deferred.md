# ADR-053 — Cursor → Azure DevOps product ROI (deferred)

**Date:** 2026-08-20  
**Status:** Accepted (deferred / future feature)  
**Deciders:** Product + platform  
**Relates to:** Product Worth; Cursor usage connector; Azure DevOps outcomes connector; ADR-018 (attribution matcher); ADR-019 (ROI templates); ADR-026 (risk-adjusted ROI); ADR-047 (LARI incremental ROI)

---

## Context

Studio’s coding stack is **Cursor** (spend, including on-demand overage) and **Azure DevOps** (work items + PRs). Today the pilot can:

1. Sync **Cursor cost + activity** (and a productivity proxy: accepted / committed lines × hourly assumptions).
2. Sync **ADO outcomes** (merged PRs → `pr_merged`, completed work items → `work_item_closed`) into Postgres `outcomes` with `source_system = azure_devops`, `business_value_usd = 0`, `attribution_confidence = 0`.
3. Run **Product Worth** as `attributed value ÷ spend` when outcomes are valued and linked — but Cursor does **not** yet get an automatic “overage dollars → shipped bugs/PRs → $ ROI” path the way Copilot gets a productivity proxy inside Product Worth.

Operators ask whether Cursor overage is worth the product delivered. That requires a closed loop the engine does not fully implement yet.

## Decision

**Track as a future feature** — do not build in the current ADO outcomes / Product Worth pass. When scheduled, ship end-to-end:

| Step | Work |
|------|------|
| 1. Value | ROI templates (or defaults) for `azure_devops` / `pr_merged` + `work_item_closed` (baseline minutes × loaded rate, bug severity tiers, etc.) so outcomes carry `business_value_usd` |
| 2. Link | Attribution rules specialized for ADO: identity (Cursor user ↔ ADO identity), time window, PR ↔ work-item refs, optional commit SHA / branch hints from Cursor Enterprise commit attribution |
| 3. Cost | Attribute Cursor metered + seat cost (incl. overage) onto linked outcomes / Product Worth for provider `cursor` |
| 4. UI | Product Worth / CFO view: Cursor verdict on **outcomes** basis (not utilization-only), with drill-down overage ↔ outcomes; keep productivity proxy as secondary confidence signal |

Acceptance sketch: for a date range with Cursor overage and ADO closures, Product Worth shows Cursor `worth_it` / `marginal` / `not_worth_it` from **attributed outcome value**, with auditable links (outcome id → confidence → spend share).

## Non-goals (still out of scope until this feature)

- Treating editor “accepted lines” alone as finance-grade ROI.
- Rewriting Go `outcome-sync` ClickHouse sinks for ADO (NestJS → Postgres remains the pilot path).
- CRM / other outcome systems beyond what’s needed for Cursor ↔ ADO.

## Consequences

- Current ADO connector remains an **outcome intake** feature; Product Worth may still show Cursor as `insufficient_data` until this lands.
- Attribution engine v2 / ROI templates are the intended building blocks — this ADR is the product commitment to wire them for **Cursor spend ↔ ADO delivery**.
- Documented here so the gap is not mistaken for a shipped capability.

## Status note

**Deferred.** Pick up after pilot ADO sync is validated in production and ROI templates for Studio’s work-item types are agreed with finance.
