package attribution

import (
	"fmt"
	"math/rand"
	"time"
)

// Golden-dataset harness (build-plan sub-phase 3.0, §6). A labeled corpus of
// (run, outcome, is_linked) pairs used to measure the engine: calibration (ECE),
// precision@high-confidence, and AUC. It seeds from deterministic links (real
// ground truth — sub-phase 3.1) PLUS this synthetic generator, which produces
// realistic agent-session/outcome timelines with KNOWN labels and injected
// confounders (slow vs fast outcome types, near-miss negatives where a developer
// was active but the agent did not contribute).
//
// Synthetic data only — never commit real customer outcome records (CLAUDE.md
// rules 1/2/14; §6). The generator is deterministic for a fixed seed so every
// metric is reproducible (§6 — determinism).

// goldenBase is the fixed clock the synthetic timelines are built around, so the
// corpus is identical across runs for a given seed.
var goldenBase = time.Date(2026, 6, 10, 9, 0, 0, 0, time.UTC)

// Scenario names the kind of (run, outcome) relationship a pair was generated to
// represent — useful for slicing metrics and for asserting coverage in tests.
const (
	ScenarioDeterministic = "deterministic"      // SDK/agent-stamped direct link (is_linked)
	ScenarioStrongPos     = "strong_positive"    // identity + token + close time (is_linked)
	ScenarioMediumPos     = "medium_positive"    // identity + close time, no token (is_linked)
	ScenarioSlowPos       = "slow_positive"      // identity + token, large gap within window (is_linked)
	ScenarioNearMissNeg   = "near_miss_negative" // dev active near an unrelated session (NOT linked)
	ScenarioUnrelatedNeg  = "unrelated_negative" // different user, outside window (NOT linked)
)

// LabeledPair is one ground-truth example: did this run actually produce this
// outcome? Run/Outcome carry only the fields the matcher reads.
type LabeledPair struct {
	Run      RunRow
	Outcome  OutcomeRow
	IsLinked bool
	Scenario string
}

// GoldenOptions controls the synthetic mix. Counts are per `scale`; scale=1 yields
// the base mix. The negative count is deliberately comparable to the positive
// count so precision metrics are meaningful.
type GoldenOptions struct {
	Scale int // multiplies every per-scenario count (>=1)
}

// GenerateGolden builds a deterministic labeled corpus for the given seed. The
// same (seed, opts) always yields the same pairs, in the same order.
func GenerateGolden(seed int64, opts GoldenOptions) []LabeledPair {
	if opts.Scale < 1 {
		opts.Scale = 1
	}
	rng := rand.New(rand.NewSource(seed)) //nolint:gosec // G404: deterministic seeded RNG for reproducible synthetic calibration data, not security-sensitive
	var pairs []LabeledPair

	// Per-scenario base counts (×scale). Positives ≈ negatives overall.
	counts := []struct {
		scenario string
		n        int
	}{
		{ScenarioDeterministic, 6},
		{ScenarioStrongPos, 8},
		{ScenarioMediumPos, 6},
		{ScenarioSlowPos, 4},
		{ScenarioNearMissNeg, 8},
		{ScenarioUnrelatedNeg, 8},
	}

	idx := 0
	for _, c := range counts {
		for i := 0; i < c.n*opts.Scale; i++ {
			pairs = append(pairs, genPair(rng, c.scenario, idx))
			idx++
		}
	}
	return pairs
}

// genPair builds one labeled pair for a scenario. The injected signals match the
// label EXCEPT for near-miss negatives, which carry real identity+time signal yet
// are NOT linked — the adversarial case that separates a calibrated engine from a
// naive correlation heuristic.
func genPair(rng *rand.Rand, scenario string, idx int) LabeledPair {
	tenant := "golden"
	user := fmt.Sprintf("u%d", idx%17) // a pool of developers
	num := 100 + idx
	outcomeID := fmt.Sprintf("github:acme/repo#%d", num)
	token := fmt.Sprintf("#%d", num)

	// Outcome time jittered through the working day so timelines overlap realistically.
	outcomeTS := goldenBase.Add(time.Duration(rng.Intn(8*60)) * time.Minute)

	o := OutcomeRow{
		OutcomeID:        outcomeID,
		TenantID:         tenant,
		TS:               outcomeTS.Format(chTime),
		SourceSystem:     "github",
		OutcomeType:      "pr_merged",
		UserID:           user,
		BusinessValueUSD: 200 + float64(rng.Intn(800)),
		CompletionStatus: "merged",
	}
	r := RunRow{
		RunID:    fmt.Sprintf("run-%d", idx),
		TenantID: tenant,
		Status:   "completed",
	}

	switch scenario {
	case ScenarioDeterministic:
		// SDK-asserted direct link: run carries the outcome_id. Matcher → 1.0.
		r.UserID = user
		r.OutcomeID = outcomeID
		r.Objective = "implement " + token
		r.EndedAt = outcomeTS.Add(-time.Duration(5+rng.Intn(20)) * time.Minute).Format(chTime)
		return LabeledPair{Run: r, Outcome: o, IsLinked: true, Scenario: scenario}

	case ScenarioStrongPos:
		// identity + token + close (10–40 min) — high probabilistic confidence.
		r.UserID = user
		r.Objective = "fix bug in " + token
		r.EndedAt = outcomeTS.Add(-time.Duration(10+rng.Intn(30)) * time.Minute).Format(chTime)
		return LabeledPair{Run: r, Outcome: o, IsLinked: true, Scenario: scenario}

	case ScenarioMediumPos:
		// identity + close time, NO token in the objective — medium confidence.
		r.UserID = user
		r.Objective = "general development work"
		r.EndedAt = outcomeTS.Add(-time.Duration(20+rng.Intn(40)) * time.Minute).Format(chTime)
		return LabeledPair{Run: r, Outcome: o, IsLinked: true, Scenario: scenario}

	case ScenarioSlowPos:
		// Slow outcome type: real link but a large gap (150–230 min) still inside
		// the window — tests per-outcome-type temporal decay (sub-phase 3.2).
		o.OutcomeType = "ticket_resolved"
		o.SourceSystem = "zendesk"
		r.UserID = user
		r.Objective = "investigate " + token
		r.EndedAt = outcomeTS.Add(-time.Duration(150+rng.Intn(80)) * time.Minute).Format(chTime)
		return LabeledPair{Run: r, Outcome: o, IsLinked: true, Scenario: scenario}

	case ScenarioNearMissNeg:
		// Adversarial: same developer, close in time, but a DIFFERENT, unrelated
		// task — the agent did not produce this outcome. Strong-looking signal,
		// label false.
		r.UserID = user
		r.Objective = "unrelated refactor"
		r.EndedAt = outcomeTS.Add(-time.Duration(15+rng.Intn(45)) * time.Minute).Format(chTime)
		return LabeledPair{Run: r, Outcome: o, IsLinked: false, Scenario: scenario}

	default: // ScenarioUnrelatedNeg
		// Different developer, run ended well outside the window — no real signal.
		r.UserID = fmt.Sprintf("v%d", idx%13)
		r.Objective = "something else entirely"
		r.EndedAt = outcomeTS.Add(-time.Duration(6*60+rng.Intn(6*60)) * time.Minute).Format(chTime)
		return LabeledPair{Run: r, Outcome: o, IsLinked: false, Scenario: scenario}
	}
}

// LabelCounts tallies positives/negatives in a corpus — what the 3.0 harness
// reports on load ("Accept when: the golden harness loads and reports label counts").
func LabelCounts(pairs []LabeledPair) (positives, negatives int) {
	for _, p := range pairs {
		if p.IsLinked {
			positives++
		} else {
			negatives++
		}
	}
	return positives, negatives
}

// ScoreGolden runs a scorer over the corpus and returns parallel (score, label)
// slices for the calibration metrics. The scorer is passed as a function so the
// V1 heuristic (the current baseline V2 must beat — sub-phase 3.3) and, later, the
// V2 pipeline can both be measured on the same corpus.
func ScoreGolden(score func(o OutcomeRow, r RunRow) float64, pairs []LabeledPair) (scores []float64, labels []bool) {
	scores = make([]float64, len(pairs))
	labels = make([]bool, len(pairs))
	for i, p := range pairs {
		scores[i] = score(p.Outcome, p.Run)
		labels[i] = p.IsLinked
	}
	return scores, labels
}

// V1Score exposes the current single-pass heuristic as a per-candidate scorer
// (no min-confidence gating) so it can serve as the calibration baseline. window
// matches the worker default (240m).
func V1Score(window time.Duration) func(o OutcomeRow, r RunRow) float64 {
	m := New(nil, window, 0, 0, nil) // ch unused by match(); minConfidence 0 → raw score
	return func(o OutcomeRow, r RunRow) float64 {
		_, conf := m.match(o, []RunRow{r})
		return conf
	}
}
