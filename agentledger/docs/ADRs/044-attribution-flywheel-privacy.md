# ADR-044 — Attribution flywheel: cross-customer priors and the anonymity guarantee

**Date:** 2026-06-22
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** ADR-040 (attribution engine v2); ADR-041 (scorer); `docs/ATTRIBUTION_ENGINE_BUILD.md` §3.6, §7, §10; CLAUDE.md rules 2/3/14/15

---

## Context

The engine gets more accurate with every customer's data — but only if a new
customer can benefit from what was learned across the others, without any customer's
data leaking. Sub-phase 3.6 builds the flywheel: nightly aggregation of
deterministic-labeled training data across tenants into **anonymized priors** that
improve cold-start accuracy for a tenant with little or no history. The build plan
(§7) makes flywheel anonymity an **absolute** constraint requiring its own ADR and a
privacy note before this ships — this document is both.

## Decision

### 1. A separate nightly worker

`services/workers/cmd/attribution-priors` (package `internal/attrpriors`) runs on a
~daily interval, independent of the inline attribution engine. It reads the
opted-in tenants' deterministic-labeled data, aggregates priors, and writes them.
Like the attribution engine it is a shadow/rollout worker — not deployed by default;
it activates with the `ATTRIBUTION_ENGINE_V2` rollout.

### 2. What the priors are — aggregates only

Two prior types in v1, both distributions/constants:
- **`signal_weight`** — a single pooled logistic scorer (weights + Platt calibrator)
  fit over all opted-in tenants' samples. This is the "industry prior" a brand-new
  tenant uses instead of the hand-set defaults.
- **`temporal_decay`** — per-outcome-type median run→outcome gap (a half-life).

No prior contains a per-tenant value, an identifier, an outcome, or a count
attributable to one customer. Each prior row records the `min_customer_n` it was
derived from.

### 3. The anonymity guarantee (the privacy note)

- **Aggregate-only.** A prior is a model or a constant fit over *pooled* samples.
  It is never a row, a per-tenant statistic, or anything from which a single tenant's
  data could be reconstructed.
- **Structural, not advisory, isolation.** `attribution_priors` has **no `tenant_id`
  column** (migration 010) and no RLS — it is global by construction, so a per-tenant
  value cannot be stored there even by mistake.
- **The `min_customer_n` gate.** `AggregatePriors` returns `Produced=false` and emits
  **nothing** unless at least `min_customer_n` (default 10) *distinct* tenants
  contributed labeled data. A single-tenant or small deployment below the threshold
  never produces priors and therefore never consumes cross-tenant signal — verified
  by `TestAggregatePriorsGate` and `TestRunnerGatedBelowMinCustomerN`.
- **Opt-out honored.** `ListOptedInTenants` excludes any tenant whose
  `tenants.compliance_flags->>'attribution_prior_optout'` is true; opted-out tenants'
  data is filtered *before* pooling, so it is never aggregated — verified by
  `TestRunnerProducesPriorsAndHonorsOptOut`.
- **Data minimization (rules 2/15).** The worker reads only the metadata the engine
  already uses (ids, timestamps, objective tokens) to build signal vectors — never
  raw prompt/completion or ticket/PR bodies.

### 4. Federated aggregation, not data sharing

The worker, running as a privileged service, necessarily *reads* multiple tenants'
data to compute an aggregate — the standard federated-aggregation model. The
guarantee is on the **output**: only aggregates clearing the gate leave the worker,
and they carry no tenant identity. Tenant data is never copied between tenant
boundaries; only the learned aggregate is shared.

### 5. Versioned rollout

The pooled scorer is registered as model version `prior-scorer-v1` in
`attribution_model_versions` (with its contributing-tenant count in `metrics`), so a
score produced from priors is reproducible and the rollout is never silent (rule 10).
New tenants consume the prior via the scorer's cold-start path; existing tenants keep
their own fitted models.

## Consequences

- A new tenant gets a calibrated scorer from day one instead of hand-set guesses —
  measured cold-start lift on a held-out synthetic tenant (`TestAggregatePriorsColdStartLift`:
  prior AUC ≥ hand-set default), growing as real data diverges from the hand-set prior.
- The anonymity guarantee is enforced in code (the gate + the schema), not just
  documented, so it cannot be silently regressed.
- The pooled-scorer prior assumes cross-tenant signal relationships are broadly
  similar; a tenant with an idiosyncratic workflow benefits less and should fit its
  own model once it has data — the prior is a *cold-start* aid, not a permanent
  override.
- Cost-of-aggregation grows with tenant count; the lookback window bounds it. Richer
  priors (baseline-deviation thresholds per team-size bucket, Shapley distributions
  per agent-type) are deferred until the v1 priors prove out in production.
