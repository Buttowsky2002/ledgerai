# ADR-041 — Attribution probabilistic scorer: interpretable log-linear model + Platt calibration

**Date:** 2026-06-22
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** ADR-040 (attribution engine v2); `docs/ATTRIBUTION_ENGINE_BUILD.md` §3.3, §6; ADR-024 (Agent Outcome Graph)

---

## Context

Sub-phase 3.3 needs a probabilistic scorer for outcome→run candidates that lack a
deterministic hard link (3.1). The build plan demands three things that are in
tension with a black-box model:

1. **Explainability is non-negotiable** — every score must carry a complete
   per-signal breakdown (the audit UI, §3.7, traces a CFO number to its evidence).
2. **Calibration is a CI gate** — a reported 0.8 must resolve to ~80% true links
   (ECE ≤ 0.05, §6); an uncalibrated score lends false authority.
3. **Self-improving from real data** — weights fit from the deterministic labels
   (3.1) with no manual labeling, reproducibly and versioned.

We also operate under the data-plane dependency-minimalism rule (CLAUDE.md
rule 12): no `gonum`/scikit, matching the project's hand-rolled ethos.

## Decision

### 1. Log-linear (logistic) scorer — the model IS its explanation

`confidence_raw = sigmoid(prior + Σ signal_weight × signal_value)`. Each signal's
`weighted_log_odds = weight × value` is, by construction, its additive contribution
to the decision — so the explanation is exact, not a post-hoc approximation (unlike
SHAP on a tree/NN). Every `Score` returns the `[]Contribution` breakdown, persisted
verbatim as `signal_contributions` on the edge. This directly satisfies (1) and is
why we chose log-linear over a gradient-boosted or neural model whose feature
attributions would be approximate and unstable.

### 2. Semi-supervised fit, hand-rolled, deterministic

Weights are fit by **full-batch gradient descent on logistic loss with an L2
ridge** (`fit.go`), stdlib-only. No randomness and a fixed iteration count, so a
refit is reproducible bit-for-bit without a seed (§3.3 acceptance). Training labels
are the deterministic edges from 3.1 (positives) plus the candidates that lost to a
hard link (negatives) — the build plan's self-improving seam. The synthetic golden
corpus (3.0) is the reproducible train/eval set until enough real labels accrue;
cold start uses the hand-set, literature-informed prior (`DefaultScorerModel`).

### 3. Platt calibration now; isotonic deferred to the flywheel

`confidence_calibrated = sigmoid(A·raw + B)`, with `A,B` fit by the same
deterministic GD (`FitPlatt`). Platt is a one-parameter-pair monotonic recalibration
— cheap, stable on small label sets, and stdlib. Isotonic regression (PAVA) is the
richer alternative the build plan names; we defer it to the flywheel (3.6), where
more labels justify the extra freedom. The calibrator is optional: with none, the
calibrated score is the identity of the raw score, so a fresh deployment still works.

### 4. Versioned, behind the flag

Each fitted model (weights + calibrator) is a row in `attribution_model_versions`
(`scorerModelVersion` serializes the full model as `params`), referenced by every
probabilistic edge — so any historical score is reproducible (rule 10). The engine
still runs in shadow behind `ATTRIBUTION_ENGINE_V2` (ADR-040).

### 5. Blocking calibration/precision gate

`TestV2BeatsV1Baseline` trains on one golden corpus and evaluates the hybrid
(deterministic resolver → scorer) on a **separate** corpus (different seed) versus
the V1 heuristic. It fails CI if V2 regresses on AUC or precision@high-confidence,
or if ECE exceeds 0.05. It runs in `make test-go`, making calibration a gate rather
than an afterthought (§6).

## Consequences

- Measured on the held-out split: **AUC 0.96 vs V1 0.83, ECE 0.035 vs V1 0.135,
  precision@0.9 1.0 vs 1.0** — V2 discriminates better and is well-calibrated where
  the heuristic was badly miscalibrated. This is the moat thesis made concrete.
- The scorer cannot separate signals it does not have: the synthetic near-miss
  negatives (a developer active near an unrelated agent session) share the temporal
  + identity signature of true links, capping AUC below 1.0. That residual is
  exactly what the counterfactual layer (3.4) addresses — not more signal weight.
- Adding a signal never touches the scorer (it consumes `[]SignalResult`
  generically and fits whatever features 3.2 registers).
- Held-out, per-tenant calibration validation on real pilot data is the flywheel's
  job (3.6) before the `ATTRIBUTION_ENGINE_V2` flag flips (ADR-040 cutover).
