package attribution

import (
	"math"
	"testing"
	"time"
)

func TestScorerExplainability(t *testing.T) {
	m := DefaultScorerModel()
	in := SignalInput{
		Outcome: OutcomeRow{OutcomeID: "github:acme/web#42", TS: "2026-06-10 10:00:00.000", OutcomeType: "pr_merged", UserID: "alice"},
		Run:     RunRow{UserID: "alice", EndedAt: "2026-06-10 09:55:00.000", Objective: "fix acme/web#42"},
		Config:  DefaultSignalConfig(),
	}
	sigs := ExtractSignals(in)
	raw, calibrated, contribs := m.Score(sigs)

	// The contributions must reconstruct the logit exactly: prior + Σ weighted_log_odds.
	logit := m.Prior
	for _, c := range contribs {
		logit += c.WeightedLogOdds
		if c.WeightedLogOdds != c.Weight*c.Value {
			t.Fatalf("contribution %s: %v != weight %v × value %v", c.Signal, c.WeightedLogOdds, c.Weight, c.Value)
		}
	}
	if math.Abs(sigmoid(logit)-raw) > 1e-9 {
		t.Fatalf("raw %v != sigmoid(reconstructed logit) %v", raw, sigmoid(logit))
	}
	if len(contribs) != 5 {
		t.Fatalf("contributions = %d, want one per signal (5)", len(contribs))
	}
	// No calibrator → calibrated == raw.
	if calibrated != raw {
		t.Fatalf("uncalibrated: calibrated %v != raw %v", calibrated, raw)
	}
	// Determinism.
	raw2, _, _ := m.Score(ExtractSignals(in))
	if raw2 != raw {
		t.Fatalf("non-deterministic score: %v vs %v", raw, raw2)
	}
}

func TestFitReproducible(t *testing.T) {
	samples := goldenFitSamples(GenerateGolden(1, GoldenOptions{Scale: 2}))
	a := FitScorer("t", samples, DefaultFitOpts())
	b := FitScorer("t", samples, DefaultFitOpts())
	if a.Prior != b.Prior {
		t.Fatalf("prior not reproducible: %v vs %v", a.Prior, b.Prior)
	}
	for k, v := range a.Weights {
		if b.Weights[k] != v {
			t.Fatalf("weight %s not reproducible: %v vs %v", k, v, b.Weights[k])
		}
	}
}

// TestV2BeatsV1Baseline is the sub-phase 3.3 acceptance AND the blocking calibration
// gate (runs in `make test-go` → CI). Trains the V2 scorer on one golden corpus and
// evaluates the hybrid (deterministic resolver → scorer) on a SEPARATE corpus
// (different seed), versus the V1 heuristic. V2 must beat V1 on AUC and
// precision@high-confidence, and be well-calibrated (ECE ≤ 0.05).
func TestV2BeatsV1Baseline(t *testing.T) {
	train := goldenFitSamples(GenerateGolden(1, GoldenOptions{Scale: 4}))
	model := FitScorer("scorer-test", train, DefaultFitOpts())
	model.Platt = FitPlatt(model, train, DefaultFitOpts())

	eval := GenerateGolden(2, GoldenOptions{Scale: 4})
	v1 := V1Score(240 * time.Minute)
	v2scores := make([]float64, len(eval))
	v1scores := make([]float64, len(eval))
	labels := make([]bool, len(eval))
	for i, p := range eval {
		v2scores[i] = hybridV2Confidence(model, p)
		v1scores[i] = v1(p.Outcome, p.Run)
		labels[i] = p.IsLinked
	}

	aucV2, aucV1 := AUC(v2scores, labels), AUC(v1scores, labels)
	eceV2, eceV1 := ExpectedCalibrationError(v2scores, labels, 10), ExpectedCalibrationError(v1scores, labels, 10)
	pV2, _ := PrecisionAtThreshold(v2scores, labels, 0.9)
	pV1, _ := PrecisionAtThreshold(v1scores, labels, 0.9)
	t.Logf("AUC  v2=%.4f v1=%.4f | ECE v2=%.4f v1=%.4f | prec@0.9 v2=%.4f v1=%.4f", aucV2, aucV1, eceV2, eceV1, pV2, pV1)

	if aucV2 < aucV1 {
		t.Fatalf("AUC regressed: v2 %.4f < v1 %.4f", aucV2, aucV1)
	}
	if pV2 < pV1 {
		t.Fatalf("precision@0.9 regressed: v2 %.4f < v1 %.4f", pV2, pV1)
	}
	if eceV2 > 0.05 {
		t.Fatalf("ECE gate: v2 %.4f > 0.05 (recalibrate)", eceV2)
	}
}

// goldenFitSamples turns labeled pairs into scorer training samples.
func goldenFitSamples(pairs []LabeledPair) []FitSample {
	out := make([]FitSample, len(pairs))
	for i, p := range pairs {
		sigs := ExtractSignals(SignalInput{Outcome: p.Outcome, Run: p.Run, Config: DefaultSignalConfig()})
		out[i] = FitSample{Signals: sigs, Label: p.IsLinked}
	}
	return out
}

// hybridV2Confidence is the production confidence: a deterministic hard link wins
// (resolver), otherwise the calibrated probabilistic score.
func hybridV2Confidence(model ScorerModel, p LabeledPair) float64 {
	if link, ok := ResolveDeterministic(p.Outcome, []RunRow{p.Run}, nil); ok {
		return link.Confidence
	}
	sigs := ExtractSignals(SignalInput{Outcome: p.Outcome, Run: p.Run, Config: DefaultSignalConfig()})
	_, calibrated, _ := model.Score(sigs)
	return calibrated
}
