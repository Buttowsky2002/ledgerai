# ADR-040 — Attribution Engine v2: storage model, dual-write contract, phased AGE

**Date:** 2026-06-22
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 3 (CLAUDE.md — "the moat"); `docs/ATTRIBUTION_ENGINE_BUILD.md`; ADR-024 (Agent Outcome Graph); ADR-026 (risk-adjusted ROI engine); ADR-010 (RLS); ADR-018 (attribution matcher)

---

## Context

`docs/ATTRIBUTION_ENGINE_BUILD.md` specs a layered, confidence-scored *causal*
attribution engine (deterministic → probabilistic → counterfactual → Shapley)
plus a calibration system, a cross-customer prior flywheel, and a confidence-audit
UI. It is written against an aspirational tree (`services/workers/attribution-matcher/`,
`attribution_edges` in Postgres, an Apache AGE graph). The repository's reality
differs in three load-bearing ways, and reconciling them is the purpose of this ADR:

1. **The graph today is a ClickHouse view** (`v_outcome_graph`, ADR-024), not Apache
   AGE. There is no graph database.
2. **There is no `attribution_edges` table.** Confidence is a single `Float32`
   column, `outcomes.attribution_confidence`, in ClickHouse.
3. **The stable downstream contract is that ClickHouse column.** `v_roi`
   (ADR-026) and `v_outcome_graph` read `o.attribution_confidence`. The build
   plan's §8 calls the contract "stable"; in this codebase that means the column,
   not a Postgres table.

The current matcher (ADR-018) is a single-pass correlation heuristic that stamps
`run_id` + `attribution_confidence` onto `outcomes`. It is a placeholder, not the
defensible engine.

## Decision

### 1. Storage model — Postgres is the rich source of truth; ClickHouse keeps the contract

The engine's explainable output (per-signal contributions, method, calibrated
confidence, counterfactual delta, coalition/Shapley allocation, model version)
lives in **Postgres** (`deploy/postgres/010_attribution_engine.sql`): RLS-scoped,
auditable, and readable by the control-plane API for the confidence-audit UI.

Six tables, split by what they describe:
- **Tenant-scoped (RLS + `FORCE`, `tenant_id` + `app_current_tenant()`):**
  `attribution_edges`, `attribution_coalitions`, `attribution_baselines`.
- **Deployment-global (no `tenant_id`):** `attribution_signals` (weights/config),
  `attribution_model_versions` (lineage + ship-time metrics).
- **Anonymized cross-tenant aggregate (no `tenant_id` by construction — §7):**
  `attribution_priors`, carrying the `min_customer_n` it was derived from.

The API role (`agentledger_api`) is **read-only** on all six (writes revoked,
mirroring `price_book` in 002_rls): only the attribution worker mutates the moat.

### 2. Dual-write — preserve the §8 contract, never fork ROI

The attribution worker becomes a dual-writer:
1. Rich edges → Postgres `attribution_edges` (+ coalitions/signals/baselines).
2. **Continue stamping `outcomes.run_id` + `outcomes.attribution_confidence`** in
   ClickHouse with the **winning edge's `confidence_calibrated`**. `v_roi` and
   `v_outcome_graph` are untouched — the ROI engine keeps reading exactly the
   column it reads today. This *is* §8 preserved.
3. Append each decision → ClickHouse `attribution_events`
   (`deploy/clickhouse/008_attribution_events.sql`) for trend analysis and
   calibration backtesting, feeding `attribution_by_agent_daily`. These analytics
   are never read by the ROI engine.

The `schemas/graph` contract is bumped **1.0 → 1.1.0** (additive: the new edge
fields are optional; `required` is unchanged), so existing consumers keep validating.

### 3. Cutover — the `ATTRIBUTION_ENGINE_V2` feature flag, shadow then flip

- **V1** (today's heuristic) keeps stamping `outcomes.attribution_confidence`.
- **V2** (the pipeline) runs in **shadow**: it computes calibrated confidence,
  writes `attribution_edges` and `attribution_events` (tagged `engine_version=v2`),
  but does **not** stamp `outcomes` until it passes the calibration (ECE ≤ 0.05),
  precision@high-confidence, and AUC gates on real pilot data.
- Flipping the flag makes V2 the stamper. This is genuine side-by-side validation
  against the live ROI numbers, exactly as §2/§8 require. V1 remains until the flip.

### 4. RLS-honoring writes (no `BYPASSRLS`)

The worker already groups candidates by tenant. It writes each tenant's edges
inside a transaction that sets `app.tenant_id` (the GUC `app_current_tenant()`
reads), so the `WITH CHECK` policy passes **without** granting the worker
`BYPASSRLS`. More secure than a bypass role and consistent with rule 3.

### 5. Apache AGE — phased and additive, behind a capability flag

The relational tables (above) and the existing ClickHouse `v_outcome_graph` are
sufficient for the full engine. AGE is adopted **additively**, not on the critical
path:
- The relational rows stay the source of truth; an AGE projection
  (`agentledger_outcome_graph`, vertices `Identity`/`Agent`/`Run`/`Outcome`, edges
  `RAN`/`PRODUCED`/`CONTRIBUTED_TO`/`ATTRIBUTED_TO`) is built by a sync step.
- Traversal endpoints are gated behind a **capability flag**; with AGE absent they
  degrade gracefully to `v_outcome_graph`. A deployment without AGE runs the entire
  engine.
- Adopting AGE means replacing the `postgres:16-alpine` base image with an
  AGE-enabled image (Debian `apache/age`) and re-validating all existing
  migrations + RLS. That is a separate, reversible step with its own follow-up ADR
  — **not** a prerequisite for any of sub-phases 3.1–3.6.

### 6. Dependency minimalism (rule 12) — hand-rolled math, zero new deps

The logistic scorer (gradient descent), calibration (isotonic via
pool-adjacent-violators / Platt), and Shapley (exact ≤ 5, seeded Monte Carlo
above) are implemented in **stdlib Go**, matching the project's hand-rolled ethos
(Prometheus, CSV, SCIM). The only datastore dependency, `lib/pq`, is already in the
workers `go.mod`. The engine adds **no new dependency**.

## Consequences

- ROI and dashboards keep working throughout the refactor; the contract they read
  never moves. Risk-adjusted ROI automatically benefits once V2 is flipped (the
  stamped confidence becomes calibrated and counterfactual-aware).
- The audit UI reads explainable edges from Postgres under RLS; the API can never
  corrupt attribution data (read-only grant).
- The flywheel's anonymity is structural: `attribution_priors` has no `tenant_id`
  column, so a per-tenant value cannot be stored there even by mistake (§7).
- AGE risk is contained to one swappable image change, deferrable indefinitely
  without blocking the engine.
- Later ADRs follow as their sub-phases land: scoring choice (3.3), counterfactual
  method (3.4), flywheel privacy model (3.6), and the AGE image adoption when taken.
