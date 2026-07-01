# BadgerIQ — Attribution Engine Build Plan (The Moat)
### Confidence-scored causal attribution: a thorough refactor spec

<!--
HOW TO USE THIS FILE:
This is the detailed build plan for the single most important feature in BadgerIQ:
the confidence-scored causal attribution layer inside the Agent Outcome Graph.

It EXPANDS Phase 3 of CLAUDE_CODE_BUILD_SPEC.md. It is a refactor: it restructures
the existing (shallow, correlation-only) attribution matcher into a layered causal
engine. Read alongside: CLAUDE.md, ARCHITECTURE_PIVOT.md, ROI_AND_CODING_AGENT_SPEC.md.

When ready, tell Claude Code:
"Read ATTRIBUTION_ENGINE_BUILD.md. We are refactoring the attribution matcher per
this plan. Begin with sub-phase 3.0 (foundations). Do not start a sub-phase until the
previous one's acceptance criteria pass."

All 15 security rules in CLAUDE.md §4 apply. This document adds engine-specific
constraints in §7 that are equally binding.
-->

---

## 1. What this refactor builds, and why it is the moat

Everything else in BadgerIQ is infrastructure a funded competitor could clone. This engine is not, because it gets **more accurate with every customer's data** (the flywheel) and because it answers the one question a CFO needs — *"would this outcome have happened without the agent?"* — which a correlation engine cannot.

The engine has four attribution layers, plus the infrastructure that makes them defensible:

1. **Deterministic attribution** — facts, not estimates (a `Co-Authored-By: Claude` trailer; an agent that closed a ticket via API). Confidence ≈ 0.95–1.0.
2. **Probabilistic attribution** — a calibrated multi-signal model combining temporal, identity, artifact, content, and behavioral signals into an *explainable* posterior confidence. Confidence ≈ 0.40–0.94.
3. **Counterfactual baseline** — incremental attribution measured against the developer/team's outcome rate *without* the agent. This is what makes ROI survive finance scrutiny.
4. **Shapley value allocation** — for multi-agent chains, distribute credit and cost across contributing agents by marginal contribution. The differentiator no competitor has.

Supporting infrastructure: a **property-graph layer** (Apache AGE on Postgres) for traversal; a **calibration system** so a 0.8 means ~80% precision; a **cross-customer prior flywheel**; and a **confidence-audit UI** that shows the evidence behind every score.

**The elegant design seam to exploit:** Layer 1 (deterministic) produces ground-truth labels that *train and calibrate* Layers 2–4. Every `Co-Authored-By` trailer is a labeled positive. This makes the whole engine self-improving from real customer data without manual labeling.

---

## 2. What this refactor replaces

The current attribution matcher is a single-pass correlation heuristic: time window + identity + file overlap → one confidence number, no explanation, no calibration, no multi-agent handling, no counterfactual. It works as a placeholder; it is not defensible.

This refactor restructures it into a **staged pipeline** (one worker, sequential internal stages) while preserving its external contract: it still emits a confidence score per outcome→agent edge that the ROI engine reads. Downstream consumers (ROI engine, dashboards) keep working throughout; they simply receive richer edges (method, calibrated confidence, signal breakdown, counterfactual delta, per-agent allocation). Build behind a feature flag `ATTRIBUTION_ENGINE_V2` so V1 and V2 can run side by side for validation before cutover.

---

## 3. Data model changes (`schemas/graph/` + `deploy/postgres/` + `deploy/clickhouse/`)

All migrations are forward-only and numbered (CLAUDE.md §2). Every table's ordering/primary scoping starts with `tenant_id` (CLAUDE.md §4.3).

**New / changed relational tables (Postgres):**

- `attribution_edges` — the core output. Columns: `id`, `tenant_id`, `outcome_id`, `run_id`, `agent_id` (nullable when part of a coalition), `coalition_id` (nullable; set for multi-agent), `attribution_method` enum(`deterministic`|`probabilistic`|`shapley`), `confidence_raw` (model output), `confidence_calibrated` (post-calibration; this is the number everyone reads), `signal_contributions` jsonb (per-signal log-odds + raw evidence references — powers the audit UI), `counterfactual_delta` (incremental fraction above baseline), `value_attributed`, `cost_attributed`, `model_version`, `created_at`. RLS enabled.
- `attribution_signals` — definitions + current weights for each signal type (temporal, identity, artifact, content, behavioral). Versioned; weight changes are audited.
- `attribution_baselines` — per `identity_id` and per `team_id`: outcome rate without agent involvement, the window it was computed over, sample size, and confounder-check results. Feeds the counterfactual layer.
- `attribution_coalitions` — for multi-agent outcomes: `coalition_id`, ordered list of contributing `agent_id`/`run_id`, and the computed Shapley allocation per member.
- `attribution_priors` — flywheel output: anonymized, aggregated priors (temporal decay constants per outcome type, baseline-deviation thresholds per team-size bucket, Shapley distributions per agent-type). Carries the `min_customer_n` it was derived from. **Never holds row-level cross-tenant data.**
- `attribution_model_versions` — every model/weight/calibration version, with the calibration metrics it shipped with (so any historical score is reproducible and auditable).

**Property-graph layer (Apache AGE — Postgres extension, no new database):**
Install AGE in the Postgres image. Project a graph `agentledger_outcome_graph` with vertex labels `Identity`, `Agent`, `Run`, `Outcome` and edge labels `RAN`, `PRODUCED`, `CONTRIBUTED_TO`, `ATTRIBUTED_TO` (carrying confidence). The relational tables remain the source of truth; the AGE projection is for traversal queries (all paths from an identity to an outcome through any agent/run combination; shortest attribution path; coalition discovery). Provide a sync mechanism (trigger or batch) from relational rows to graph elements. **Decision recorded in ADR:** start with AGE because it adds graph queries to existing Postgres with zero new infrastructure; only evaluate a dedicated graph DB if traversal latency outgrows AGE at real scale (don't adopt prematurely).

**ClickHouse:** add an `attribution_events` analytical table (append-only, `tenant_id` leads ordering) capturing each attribution decision for trend analysis and calibration backtesting, and feed an MV for "attributed value/cost by agent by day."

---

## 4. Engine architecture — the attribution pipeline

Refactor `services/workers/attribution-matcher/` into a sequential pipeline. It is triggered when a new outcome arrives (from the outcome connectors) or a run completes. Stages run in order; each stage enriches an in-memory `AttributionContext`:

```
outcome/run event
   │
   ▼
[1] Candidate generation
   Find plausible (run → outcome) pairs within a generous window per outcome type.
   Cheap recall-first pass; precision comes later.
   │
   ▼
[2] Deterministic resolver        ──► if a hard link exists (trailer, session-id,
   Checks for ground-truth signals.    API-close), emit edge method=deterministic,
                                        confidence≈0.97, SKIP probabilistic stages.
   │ (no hard link)                     These also become training labels.
   ▼
[3] Signal extraction
   For each candidate, compute every signal (temporal, identity, artifact, content,
   behavioral) as a normalized value + a raw evidence reference for the audit trail.
   │
   ▼
[4] Probabilistic scorer (log-linear / logistic)
   prior_log_odds + Σ (signal_weight × signal_value) → sigmoid → confidence_raw.
   Interpretable: each signal's weighted log-odds IS its explanation.
   │
   ▼
[5] Counterfactual adjustment
   Look up the identity/team baseline; compute incremental fraction (observed vs
   baseline). Scale value_attributed by the incremental share, not the gross.
   │
   ▼
[6] Multi-agent Shapley (only if coalition_id set)
   Compute each agent's marginal contribution across orderings; allocate value and
   cost by Shapley value. Exact for ≤5 agents; Monte Carlo permutation sampling above.
   │
   ▼
[7] Calibration
   Map confidence_raw → confidence_calibrated using the fitted calibrator
   (isotonic/Platt). This is the number persisted and shown.
   │
   ▼
[8] Persistence
   Write attribution_edges (+ coalition allocation, signal_contributions),
   project into AGE graph, emit attribution_event to ClickHouse.
```

A **separate scheduled worker** `services/workers/attribution-priors/` runs the flywheel: nightly it (a) refits signal weights via logistic regression using deterministic edges as labels, (b) recomputes calibration curves, (c) recomputes per-identity/team baselines, and (d) aggregates anonymized cross-customer priors (gated by `min_customer_n`). New model versions are written to `attribution_model_versions` and rolled out behind the feature flag, never silently.

---

## 5. Build sub-phases (execute in order; each gates the next)

### 3.0 — Foundations (graph schema, AGE, test harness) — ~1.5 weeks
- Write the migrations for all §3 tables; install and configure Apache AGE; build the relational→AGE projection.
- Build the **golden dataset harness**: a labeled corpus of (run, outcome, is_linked) pairs — seed it from deterministic links (real ground truth) plus a synthetic generator that produces realistic agent-session/outcome timelines with known labels and injected confounders.
- Stand up the calibration test scaffolding (reliability-diagram + Expected Calibration Error computation) so later stages can be measured.
- **Accept when:** migrations apply forward-only and reverse cleanly in a throwaway DB; an AGE Cypher query returns all paths from a seeded identity to a seeded outcome; the golden harness loads and reports label counts; `make test` green.

### 3.1 — Deterministic layer — ~1 week
- Implement the deterministic resolver: GitHub `Co-Authored-By` trailer parsing, SDK session-id stamps in PR/issue/commit metadata, ticket references found inside agent tool-call logs, and direct agent-API close events.
- Emit `method=deterministic` edges at fixed high confidence; tag them as labels for training.
- **Accept when:** a seeded repo with a `Co-Authored-By: Claude` PR linked to a Jira ticket produces a deterministic edge end-to-end with the PR URL and ticket id captured as evidence; precision on the deterministic test set is 1.0 by construction; these edges appear in the labels table.

### 3.2 — Signal extraction framework — ~1.5 weeks
- Implement each signal as an independent, unit-tested function returning a normalized value + an evidence reference: temporal proximity (with per-outcome-type decay), identity match, artifact/file overlap, content/keyword match (ticket id, branch name in session), behavioral (commit within N minutes of session end).
- Signals are config-driven (weights live in `attribution_signals`); adding a signal must not require touching the scorer.
- **Accept when:** every signal has tests covering present/absent/partial cases; signal output for a known candidate is deterministic and explainable; no signal reads raw prompt/completion content (CLAUDE.md §4.2) — only metadata and categorical evidence.

### 3.3 — Probabilistic scorer + explainability — ~2 weeks
- Implement the log-linear scorer (prior log-odds + weighted signals → sigmoid). Initialize weights as hand-set priors, then fit via logistic regression against the deterministic labels from 3.1 (semi-supervised).
- Persist `signal_contributions` (each signal's weighted log-odds + evidence ref) on every edge — this is non-negotiable; the score is worthless without its explanation.
- **Accept when:** on the golden set, the scorer beats the old single-window heuristic on AUC and precision@high-confidence; every score has a complete contribution breakdown; refitting weights from labels is reproducible (fixed seed) and versioned.

### 3.4 — Counterfactual baseline — ~2 weeks
- Build per-identity and per-team baseline computation from pre-adoption history and non-adopter cohorts (difference-in-differences framing). Compute incremental attribution as the share of outcomes above baseline.
- Add the validity checks the literature requires: overlap (don't compare non-comparable cohorts), placebo (no "effect" on pre-period outcomes), and sensitivity to hidden confounders — surface these as confidence caveats on the edge, not silent assumptions.
- **Accept when:** an agent whose developer already closed N tickets/sprint unassisted shows a *reduced* incremental attribution (not full credit); the baseline, its sample size, and confounder-check results are stored and visible; ROI headline numbers use incremental, not gross, value.

### 3.5 — Shapley multi-agent allocation — ~1.5 weeks
- Implement coalition detection (multiple runs/agents contributing to one outcome) and Shapley allocation of both value and cost: exact computation for ≤5 agents, Monte Carlo permutation sampling (fixed seed, reported confidence interval) beyond.
- **Accept when:** a seeded 3-agent chain (research → implement → review) closing one ticket produces three edges whose allocations sum to the outcome value and reflect marginal contribution; allocation is deterministic for the exact case and within tolerance for the sampled case; per-agent cost-per-outcome reflects the allocation.

### 3.6 — Flywheel (cross-customer priors) — ~1.5 weeks
- Build `attribution-priors` worker: nightly weight refit, calibration recompute, baseline refresh, and **anonymized aggregate prior** computation gated by `min_customer_n` (start at 10). Priors are distributions/constants only — never row-level cross-tenant data. Tenants can opt out.
- **Accept when:** with ≥`min_customer_n` synthetic tenants, industry priors are produced and measurably improve cold-start confidence for a held-out tenant; a single-tenant deployment below the threshold never consumes cross-tenant priors; an ADR + privacy note documents the aggregation and the anonymity guarantee.

### 3.7 — Confidence-audit UI — ~1.5 weeks (in `apps/dashboard/`)
- Build the drill-down: any attributed value/score expands to show every contributing signal, its weight/contribution, the raw evidence (PR URL, ticket id, timestamps, file overlap %, baseline delta), the attribution method, and the model version. For coalitions, show the Shapley split.
- Treat all displayed evidence as untrusted output and encode it (CLAUDE.md §4.5, §4.13).
- **Accept when:** a reviewer can click a CFO-view number and trace it to source evidence end-to-end; deterministic vs probabilistic vs Shapley edges are visually distinct; low-confidence/below-threshold edges are clearly marked as excluded from headline aggregates.

---

## 6. Testing & calibration strategy (the part teams get wrong)

A confidence score that is not **calibrated** is worse than none, because it lends false authority. This engine's test suite must enforce calibration as a CI gate, not an afterthought.

- **Golden labeled dataset** (from 3.0): deterministic real links as ground-truth positives, plus a synthetic generator producing realistic timelines with known labels and injected confounders (slow vs fast outcome types, multi-agent chains, near-miss negatives where a developer was active but the agent didn't contribute).
- **Calibration gate**: compute a reliability diagram and Expected Calibration Error on every model version; CI fails if ECE exceeds a threshold (e.g. 0.05). A bucket of edges scored ~0.8 must resolve to ~80% true links. Recalibrate (isotonic/Platt) until it does.
- **Precision/recall gate**: track precision@high-confidence (≥0.9) and overall AUC against the golden set; CI fails on regression versus the prior model version.
- **Backtesting**: replay historical (pre-deployment) outcomes through the engine and compare attributed incremental value to known reality where available.
- **Determinism**: all stochastic components (Monte Carlo Shapley, any sampling) use fixed seeds in tests; same inputs → same outputs.
- **No PII in fixtures** (CLAUDE.md §4.1, §4.14): synthetic data only; never commit real customer outcome records.
- **Adversarial cases**: a developer active near an unrelated agent session (should score low), an agent that touched files later reverted (low survival → low/again-discounted), and a coalition where one agent contributed nothing (Shapley ≈ 0).

---

## 7. Engine-specific security & privacy constraints (binding, additional to CLAUDE.md §4)

- **Flywheel anonymity is absolute.** `attribution_priors` contains only aggregate statistics derived from ≥`min_customer_n` tenants. No row-level, identifiable, or single-tenant-derivable value ever crosses a tenant boundary. Opt-out is honored. This gets its own ADR and a privacy review before 3.6 ships.
- **Outcome-connector data minimization** (CLAUDE.md §4.15): pull only the fields needed for attribution (ids, timestamps, story points, file lists, the AI trailer) — never raw ticket bodies, issue descriptions, or PR diffs unless a specific signal requires a field, and document each one.
- **Evidence references, not payloads.** `signal_contributions` stores *references* (PR URL, ticket id, timestamps, overlap percentages) and categorical findings — not copied content. The audit UI fetches live where needed, scoped by tenant.
- **Tenant isolation in the graph.** AGE projections are per-tenant scoped at query time; a cross-tenant traversal must be impossible by construction. Add the cross-tenant attribution-read test to the permanent CI suite.
- **Model decisions are auditable** (CLAUDE.md §4.10): every weight change, calibration update, and prior rollout is written to `attribution_model_versions` and the audit log, so any historical score is explainable and reproducible.

## 8. Interfaces & contracts (so nothing downstream breaks)

- **ROI engine** reads `confidence_calibrated`, `counterfactual_delta`, and `value_attributed`/`cost_attributed` from `attribution_edges`. Risk-adjusted ROI multiplies by `confidence_calibrated` and uses incremental (counterfactual) value. This contract is stable; the engine refactor only enriches the fields behind it.
- **Dashboards** read edges + `signal_contributions` for the audit UI and the CFO/CISO/cost-per-outcome views.
- **Event/edge schema** in `schemas/graph/` is the contract between this engine and its consumers — version it; breaking changes require a migration plan.
- **Feature flag** `ATTRIBUTION_ENGINE_V2` governs cutover; V1 remains until V2 passes calibration and precision gates on real pilot data.

## 9. Sequencing, dependencies, effort

Strictly sequential: 3.0 → 3.1 → 3.2 → 3.3. Then 3.4 and 3.5 can proceed in parallel if two builders exist (both depend on 3.3, not on each other). 3.6 depends on 3.1 (labels) and 3.3 (model). 3.7 can begin once 3.3 emits `signal_contributions` and proceed alongside 3.4–3.6.

Total: roughly **11–13 focused weeks** solo (the ~weeks per sub-phase above), compressible with parallelism on 3.4/3.5/3.7. This deepens Phase 3 of the master spec; Phases 4–6 (ROI dashboards, risk engine, enterprise hardening) follow and consume this engine's output.

## 10. Risks & mitigations

- **Cold-start before the flywheel** — early customers get less-calibrated scores. *Mitigation:* lead every demo and headline number with deterministic (Layer 1) outcomes, which need no priors; lean on hand-set, literature-informed priors until `min_customer_n` is reached.
- **Calibration drift** as customer mix changes. *Mitigation:* nightly recalibration + the CI ECE gate; alert on drift.
- **Over-trust in scores** by users. *Mitigation:* the audit UI and explicit confidence bands; never present a probabilistic number without its evidence; mark below-threshold edges as excluded.
- **Shapley cost** on large coalitions. *Mitigation:* exact only to ≤5; Monte Carlo with bounded samples above; coalitions are small in practice.
- **Counterfactual validity** (confounders break the baseline). *Mitigation:* the overlap/placebo/sensitivity checks from 3.4 surfaced as caveats, not hidden; be conservative when checks fail.
- **Refactor regression** breaking ROI/dashboards. *Mitigation:* the stable edge contract (§8) + the `ATTRIBUTION_ENGINE_V2` flag + side-by-side validation before cutover.

## 11. Definition of done (whole engine)

The engine is done when: all sub-phase criteria pass via `make` targets reproducibly; the calibration (ECE), precision@high-confidence, and AUC gates are green in CI and enforced on every model version; deterministic, probabilistic, counterfactual, and Shapley paths all produce auditable edges with full evidence; the flywheel improves held-out cold-start accuracy while provably preserving cross-tenant anonymity; the confidence-audit UI traces any headline number to source evidence; the cross-tenant attribution-read test is in the permanent CI suite; ADRs exist for AGE adoption, the Bayesian/log-linear scoring choice, the counterfactual method, and the flywheel privacy model; and V2 has matched-or-beaten V1 on real pilot data before the flag flips.
