package attribution

import (
	"reflect"
	"testing"
	"time"
)

func TestGenerateGoldenDeterministic(t *testing.T) {
	a := GenerateGolden(42, GoldenOptions{Scale: 1})
	b := GenerateGolden(42, GoldenOptions{Scale: 1})
	if !reflect.DeepEqual(a, b) {
		t.Fatal("same seed produced different corpora — generator is not deterministic")
	}
	if len(a) == 0 {
		t.Fatal("empty corpus")
	}
}

func TestGenerateGoldenLabelCounts(t *testing.T) {
	pairs := GenerateGolden(7, GoldenOptions{Scale: 1})
	pos, neg := LabelCounts(pairs)
	// Base mix: positives = deterministic(6)+strong(8)+medium(6)+slow(4) = 24;
	// negatives = near_miss(8)+unrelated(8) = 16.
	if pos != 24 || neg != 16 {
		t.Fatalf("label counts = %d pos / %d neg, want 24/16", pos, neg)
	}
	if pos+neg != len(pairs) {
		t.Fatalf("counts (%d) != corpus size (%d)", pos+neg, len(pairs))
	}
}

func TestGenerateGoldenScenarioCoverage(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range GenerateGolden(1, GoldenOptions{Scale: 2}) {
		seen[p.Scenario] = true
	}
	for _, s := range []string{
		ScenarioDeterministic, ScenarioStrongPos, ScenarioMediumPos,
		ScenarioSlowPos, ScenarioNearMissNeg, ScenarioUnrelatedNeg,
	} {
		if !seen[s] {
			t.Fatalf("scenario %q absent from corpus", s)
		}
	}
}

// TestV1Baseline measures the current single-pass heuristic on the golden set.
// This is the calibration BASELINE the V2 engine must beat on AUC and
// precision@high-confidence (build-plan sub-phase 3.3). It also exercises the
// generator→scorer→metrics scaffolding end to end. Run via `make attr-calibration`.
func TestV1Baseline(t *testing.T) {
	pairs := GenerateGolden(2026, GoldenOptions{Scale: 3})
	scores, labels := ScoreGolden(V1Score(240*time.Minute), pairs)

	// Deterministic (SDK-stamped) pairs must score exactly 1.0 — ground truth.
	for i, p := range pairs {
		if p.Scenario == ScenarioDeterministic && scores[i] != 1.0 {
			t.Fatalf("deterministic pair %s scored %v, want 1.0", p.Run.RunID, scores[i])
		}
	}

	auc := AUC(scores, labels)
	ece := ExpectedCalibrationError(scores, labels, 10)
	prec, n := PrecisionAtThreshold(scores, labels, 0.9)
	t.Logf("V1 baseline on golden set: AUC=%.4f ECE=%.4f precision@0.9=%.4f (n=%d)", auc, ece, prec, n)

	// The heuristic discriminates better than chance (sanity floor for the baseline).
	if auc <= 0.6 {
		t.Fatalf("V1 baseline AUC = %.4f, expected > 0.6 on the synthetic corpus", auc)
	}
}
