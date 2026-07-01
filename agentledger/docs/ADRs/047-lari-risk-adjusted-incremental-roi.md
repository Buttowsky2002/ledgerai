# ADR-047 — LARI: Risk-Adjusted Incremental ROI engine

**Date:** 2026-06-23
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 4 ROI engine (`v_roi`, ADR-026), the attribution engine (ADR-040–044),
ADR-046 (Outcome Graph MVP); security rules 2 (no content) / 3 (tenant isolation) / 4 / 10.

---

## Context

`v_roi` already computes a risk-adjusted ROI per outcome (`value × confidence × (1 − risk) −
fully_loaded_cost`). It is correct but (a) a flat number with no explanation, (b) has no explicit
uncertainty handling, and (c) gives no action guidance. Finance and CISO buyers need a single,
**explainable, auditable, deterministic** per-agent figure that nets out incrementality, fully-loaded
cost, expected risk loss, and the uncertainty of the evidence — and that recommends what to do.

## Decision

Add **LARI** — BadgerIQ Risk-Adjusted Incremental ROI — as a pure TypeScript engine in
`services/api/src/lari/` (framework-free functions + types), plus a thin `GET /v1/agents/:id/lari`
endpoint that assembles its input from live data.

**Formula:**

```
LARI = ( AttributedIncrementalValue
         − FullyLoadedAgentCost
         − ExpectedRiskLoss
         − UncertaintyReserve )
       / max(FullyLoadedAgentCost, epsilon)
```

- **AttributedIncrementalValue** = Σ grossValue × attributionConfidence × incrementalityFactor.
  Both factors ∈ [0,1], so gross value is discounted to the share the agent both plausibly caused
  *and* that would not have happened anyway. Manual outcomes (low attribution confidence) are
  discounted automatically.
- **FullyLoadedAgentCost** = token + human review + infra (eval/monitoring/integration/platform) +
  amortized build.
- **ExpectedRiskLoss** = valueAtRisk × incidentProbability, where valueAtRisk = explicit figure, else
  attributedValue × riskExposurePct. More risk ⇒ larger loss ⇒ lower LARI.
- **UncertaintyReserve** = positiveValue × (1 − confidence/100) × factor. Low-confidence value is held
  back, so a big headline with weak evidence yields a low LARI and an `improve_evidence` steer.
- **epsilon** floors the denominator so zero cost never divides by zero (default 1e-9; the result is
  finite and reads as very large, which the ledger flags).

**ConfidenceScore** (0–100) = 100 × (0.25·evidenceQuality + 0.20·attributionStrength +
0.20·causalStrength + 0.15·costCompleteness + 0.10·outcomeVerification + 0.10·recency). Weights sum to 1.

**Recommendation** (ordered decision tree): critical risk → `require_approval` (ROI ≥ 0) or `pause`
(ROI < 0); else negative ROI → `retire` (≈no value) or `investigate`; else low confidence →
`improve_evidence`; else strong + confident → `scale`; thin margin → `optimize`; otherwise `maintain`.

**Evidence ledger:** every result carries value/cost/risk drivers, confidence factors, attribution
reasons, the baseline method, and limitations — so any figure traces to its inputs.

**Determinism (requirements 7–8):** the engine is pure — no clock, randomness, I/O, or LLM calls;
`occurredAt`/period are passed in. LLMs may *elsewhere* classify text or summarize evidence into the
categorical inputs, but never decide a financial figure. No type carries raw prompt/response content;
only numbers, categories, and structural references.

**Endpoint assembler:** `LariService` builds `AgentROIInput` from ClickHouse (`v_roi` for value +
loaded-cost components + confidence + risk exposure; `spend_hourly_by_key` for true token spend;
`risk_events` for severity; `outcomes` for provenance/verification) and Postgres `attribution_edges`
for the counterfactual delta + method (via `$queryRaw` under `withTenant` — that table has no Prisma
model). All ClickHouse reads use `queryScoped` (tenant bound from the principal). Heuristics where data
is thin (documented in the ledger's limitations): incrementality defaults to 1.0 (full credit) when no
counterfactual baseline exists; `causalStrength` is then low (0.3) so the uncertainty reserve rises;
incident probability is mapped from severity.

## Consequences

- A single explainable per-agent ROI with an action label, reusing `v_roi` for the financial truth
  (no duplicate cost/value math) and the attribution engine for incrementality.
- Pure core is exhaustively unit-tested (the spec's nine cases + invariants); the endpoint adds an
  assembler unit test + a tenant-scoped e2e. No migration; no new dependency.
- Thresholds and confidence weights are named constants, easy to tune as real pilot data arrives.
