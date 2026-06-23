package attribution

import (
	"math"
	"testing"
)

func approx(a, b, tol float64) bool { return math.Abs(a-b) <= tol }

func TestExpectedCalibrationError(t *testing.T) {
	// A perfect separator (positives→1.0, negatives→0.0) is perfectly calibrated.
	scores := []float64{1, 1, 1, 0, 0, 0}
	labels := []bool{true, true, true, false, false, false}
	if ece := ExpectedCalibrationError(scores, labels, 10); !approx(ece, 0, 1e-9) {
		t.Fatalf("perfect calibration ECE = %v, want 0", ece)
	}

	// Overconfident: everything scored 0.9 but only half are true → |0.5-0.9|=0.4.
	scores = []float64{0.9, 0.9, 0.9, 0.9}
	labels = []bool{true, true, false, false}
	if ece := ExpectedCalibrationError(scores, labels, 10); !approx(ece, 0.4, 1e-9) {
		t.Fatalf("overconfident ECE = %v, want 0.4", ece)
	}

	if ece := ExpectedCalibrationError(nil, nil, 10); ece != 0 {
		t.Fatalf("empty ECE = %v, want 0", ece)
	}
}

func TestReliabilityDiagramBins(t *testing.T) {
	scores := []float64{0.05, 0.95, 1.0}
	labels := []bool{false, true, true}
	bins := ReliabilityDiagram(scores, labels, 10)
	if len(bins) != 10 {
		t.Fatalf("bins = %d, want 10", len(bins))
	}
	if bins[0].Count != 1 || !approx(bins[0].MeanLabel, 0, 1e-9) {
		t.Fatalf("bottom bin = %+v", bins[0])
	}
	// 0.95 and 1.0 both land in the top bin (top bin includes 1.0).
	if bins[9].Count != 2 || !approx(bins[9].MeanLabel, 1, 1e-9) {
		t.Fatalf("top bin = %+v", bins[9])
	}
}

func TestAUC(t *testing.T) {
	// Perfectly separable: every positive outscores every negative.
	if a := AUC([]float64{0.9, 0.8, 0.2, 0.1}, []bool{true, true, false, false}); !approx(a, 1, 1e-9) {
		t.Fatalf("separable AUC = %v, want 1", a)
	}
	// Reversed ranking → 0.
	if a := AUC([]float64{0.1, 0.2, 0.8, 0.9}, []bool{true, true, false, false}); !approx(a, 0, 1e-9) {
		t.Fatalf("reversed AUC = %v, want 0", a)
	}
	// All identical scores → pure ties → 0.5 (no discrimination).
	if a := AUC([]float64{0.5, 0.5, 0.5, 0.5}, []bool{true, true, false, false}); !approx(a, 0.5, 1e-9) {
		t.Fatalf("tied AUC = %v, want 0.5", a)
	}
	// One class empty → 0.5.
	if a := AUC([]float64{0.9, 0.1}, []bool{true, true}); !approx(a, 0.5, 1e-9) {
		t.Fatalf("single-class AUC = %v, want 0.5", a)
	}
}

func TestPrecisionAtThreshold(t *testing.T) {
	scores := []float64{0.95, 0.91, 0.6, 0.92}
	labels := []bool{true, false, true, true}
	p, n := PrecisionAtThreshold(scores, labels, 0.9)
	if n != 3 || !approx(p, 2.0/3.0, 1e-9) {
		t.Fatalf("precision@0.9 = %v over %d, want 2/3 over 3", p, n)
	}
	if p, n := PrecisionAtThreshold(scores, labels, 0.99); n != 0 || p != 0 {
		t.Fatalf("precision@0.99 = %v over %d, want 0 over 0", p, n)
	}
}
