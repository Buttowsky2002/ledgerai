# ADR-043 — Shapley multi-agent allocation: characteristic function and the value/cost split

**Date:** 2026-06-22
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** ADR-040 (attribution engine v2); ADR-041 (scorer); ADR-042 (counterfactual); `docs/ATTRIBUTION_ENGINE_BUILD.md` §3.5, §6

---

## Context

Agents increasingly work in chains: a research agent gathers context, an implement
agent writes the code, a review agent checks it — and together they close one
ticket. Crediting the whole outcome to one of them (or splitting it equally) is
wrong and is the kind of thing a competitor's correlation engine cannot do. Sub-phase
3.5 needs a principled split of value across the contributing agents by **marginal
contribution**. Shapley value is the unique allocation satisfying efficiency,
symmetry, null-player, and additivity — the right tool. The open questions are: what
is the characteristic function, how is cost handled, and how do we keep it tractable
and reproducible.

## Decision

### 1. Characteristic function: noisy-OR of attribution confidence

`v(S) = 1 − Π_{i∈S}(1 − c_i)`, where `c_i` is run *i*'s individual attribution
confidence to the outcome (deterministic 1.0/0.97, or the calibrated probabilistic
score). `v(∅) = 0`. This reads as "the probability the outcome is explained by *some*
member of S," and has the property the build plan demands: a member that adds no
marginal confidence — a redundant agent, or one with `c_i = 0` — earns Shapley ≈ 0
(the adversarial "contributed nothing" case). We chose noisy-OR over a sum or max
because it is monotone, bounded in [0,1], rewards complementary contributions, and
discounts redundant ones — matching how overlapping agents actually relate.

### 2. Value by Shapley, cost by incurrence

Shapley values are normalized to **shares summing to 1**, so per-member value
allocations sum exactly to the outcome value (the §3.5 acceptance). **Cost**, however,
is allocated by **incurrence** — each member's edge carries its own run's
`total_cost_usd` — not split by Shapley weights. Splitting cost by Shapley would
charge a cheap review agent for tokens it never spent; FinOps needs each agent's
*actual* spend against its *credited* value. So per-agent cost-per-outcome =
(own cost) / (Shapley value share × outcome value), which reflects the allocation
exactly as the acceptance requires, while keeping cost truthful. The members JSON
records each member's `shapley_value` and own `cost_usd` for the audit UI.

### 3. Exact ≤ 5, seeded Monte Carlo above

Exact Shapley by subset enumeration is `O(2^n)` — trivial for the small coalitions
seen in practice, so it is used for `n ≤ 5`. Above that, permutation Monte Carlo
estimates the values and reports a 95% confidence half-width per member. The sampler
is seeded deterministically from `(tenant, outcome_id)`, so the same coalition always
produces the same allocation — reproducible in CI and across passes (§6). stdlib
`math/rand` only (rule 12).

### 4. Coalition detection and deterministic identity

A coalition is any outcome with **≥ 2 distinct contributing agents**, where a
contributor is a run with a hard link (SDK stamp or evidence naming it) or a
probabilistic candidate clearing `minConfidence`, deduped to the best run per agent.
Single-contributor outcomes keep the existing deterministic/probabilistic single-edge
path untouched. The `coalition_id` is a deterministic UUIDv5 of `(tenant, outcome)`,
so re-runs upsert the same coalition row and the member edges' `coalition_id` foreign
key always resolves (coalitions are persisted before edges).

## Consequences

- Multi-agent chains get a defensible per-agent credit split that sums to the
  outcome value and zeroes out free-riders — a capability no competitor productizes.
- The member edges are `method=shapley`, `model_version=shapley-v1`, carry the
  member's individual confidence and own cost, and reference the coalition row whose
  `members` JSON holds the full allocation (and MC confidence intervals).
- Counterfactual scaling (3.4) composes cleanly: each member edge's value is
  `outcome_value × shapley_share`, then scaled by the outcome's `counterfactual_delta`
  in the same phase — so coalition allocations remain incremental and sum to the
  incremental outcome value.
- Because a probabilistic candidate clearing `minConfidence` counts as a contributor,
  a run that merely ended *near* an unrelated outcome can be pulled into a coalition
  (a false coalition member). This is a limit of the current signals, not the
  allocation: the counterfactual layer and richer signals reduce it, and a higher
  coalition-inclusion threshold is an available lever. Surfaced here, not hidden.
- The noisy-OR characteristic assumes member confidences are independent evidence;
  strongly correlated runs (e.g. two near-identical sessions) will each be discounted
  somewhat, which is acceptable (we would not want to double-count them) but is a
  modeling choice worth revisiting if real coalitions show heavy duplication.
