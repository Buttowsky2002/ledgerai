# ADR-042 — Attribution counterfactual baseline: incremental value, not gross

**Date:** 2026-06-22
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** ADR-040 (attribution engine v2); ADR-041 (probabilistic scorer); ADR-026 (risk-adjusted ROI); `docs/ATTRIBUTION_ENGINE_BUILD.md` §3.4, §7

---

## Context

Raw attribution (deterministic 3.1, probabilistic 3.3) credits an agent with the
**gross** value of an outcome it plausibly produced. A CFO will not accept that: the
question is *incremental* — *would this outcome have happened without the agent?*
A developer who already merged 8 PRs/sprint unassisted should not have a 9th,
agent-assisted PR counted as full new value. Without this layer, ROI is overstated
and the number dies under finance scrutiny.

The probabilistic scorer (ADR-041) provably cannot resolve this: its synthetic
near-miss negatives share the temporal+identity signature of true links. The
residual is not a missing signal — it is a *counterfactual* question, and needs a
baseline, not more weight.

## Decision

### 1. Incremental value via a per-subject baseline

For each `(identity, outcome_type)` — falling back to `(team, outcome_type)` — over
the pass window, estimate the **baseline share**: the fraction of that subject's
outcomes produced **without** an agent (operationally: outcomes the engine could not
attribute to a run). The incremental fraction is the complement:

```
counterfactual_delta = clamp01(1 − baseline_count / total_count)
value_attributed     = gross_value × counterfactual_delta
```

A subject who ships mostly unassisted has a high baseline share → low delta → reduced
credit (the §3.4 acceptance). A subject who only produces with an agent has delta ≈ 1.

### 2. Share-based v1; difference-in-differences deferred

This is a **share-based** estimator, not yet the rate-based difference-in-differences
the build plan ultimately wants (pre-adoption vs adoption rates, non-adopter cohorts).
We chose it for v1 because it needs only the outcome stream we already have, is
interpretable, and satisfies the acceptance. The DiD refinement — comparing a
subject's outcome *rate* across a pre-adoption window to the adoption window — is the
documented next step, deferred to the flywheel (3.6) where enough history accrues.
The estimator is versioned (`counterfactual-v1`) so the upgrade is a new version, not
a silent change (rule 10).

### 3. Validity checks travel as caveats — never silent (§7)

Every baseline carries three checks, stored in `attribution_baselines.confounder_checks`
and surfaced in the audit UI:

- **overlap** — is the sample adequate to compare? (`total ≥ 4`, else fall back).
- **placebo** — was the unassisted counterfactual actually observed? (`baseline > 0`;
  a delta of 1 from zero baseline is an upper bound, flagged `baseline_unobserved`).
- **sensitivity** — does delta move more than 0.2 under a +1 Laplace perturbation of
  the baseline count? (flags small, noisy estimates).

### 4. Conservative on failure

When neither the identity nor the team baseline has adequate overlap, the engine does
**not** fabricate a discount — it uses full credit (delta 1.0) flagged `no_baseline`.
We discount only what we can defend; an unestimable counterfactual is surfaced, not
guessed. Headline aggregates (3.7) may exclude caveated edges.

### 5. Where the incremental value lands

The edge stores `counterfactual_delta` and an **incremental** `value_attributed`
(gross × delta). The ROI engine (`v_roi`, ADR-026) still reads the ClickHouse
`outcomes` column today; it consumes the edge's incremental, confidence-weighted
value at cutover (ADR-040 flag flip): `roi = value_attributed × confidence_calibrated
× (1 − risk)`. Until then, the engine remains in shadow and the incremental value is
visible on the edge without moving live ROI.

## Consequences

- ROI headline numbers become incremental, the form finance trusts — and the
  near-miss confounder the scorer could not separate is now handled by the layer
  designed for it.
- Baselines are persisted per subject with their sample size and confounder checks,
  so any discount is auditable and reproducible.
- The crude share-based proxy will over- or under-credit when adoption itself changed
  a subject's unassisted productivity; the placebo caveat flags the worst cases, and
  the DiD refinement (3.6) is the principled fix. Documented, not hidden.
- `baseline_count` uses "could not attribute" as the unassisted proxy, which couples
  the baseline to the engine's own recall. As recall improves (more signals,
  connectors), baselines shift — acceptable because both are versioned and recomputed.
