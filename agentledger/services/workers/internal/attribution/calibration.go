package attribution

import (
	"math"
	"sort"
)

// Calibration scaffolding (build-plan sub-phase 3.0, §6). A confidence score that
// is not calibrated is worse than none, because it lends false authority — so the
// engine measures calibration as a first-class metric. These are the pure
// computations the CI gate (3.3+) enforces; stdlib only (CLAUDE.md rule 12).
//
// All functions take parallel slices: scores[i] in [0,1] is the predicted
// confidence and labels[i] is the ground truth for the same candidate.

// ReliabilityBin is one bucket of a reliability diagram: predictions whose score
// falls in [Lo, Hi) (the top bin includes 1.0). A well-calibrated model has
// MeanLabel ≈ MeanScore in every populated bin.
type ReliabilityBin struct {
	Lo        float64 `json:"lo"`
	Hi        float64 `json:"hi"`
	Count     int     `json:"count"`
	MeanScore float64 `json:"mean_score"` // average predicted confidence in the bin
	MeanLabel float64 `json:"mean_label"` // observed positive fraction in the bin
}

// ReliabilityDiagram buckets predictions into `bins` equal-width score bins and
// reports, per bin, the mean predicted score vs the observed positive rate.
func ReliabilityDiagram(scores []float64, labels []bool, bins int) []ReliabilityBin {
	if bins < 1 {
		bins = 1
	}
	out := make([]ReliabilityBin, bins)
	sumScore := make([]float64, bins)
	sumLabel := make([]int, bins)
	for i := range out {
		out[i].Lo = float64(i) / float64(bins)
		out[i].Hi = float64(i+1) / float64(bins)
	}
	for i, s := range scores {
		b := binIndex(s, bins)
		out[b].Count++
		sumScore[b] += clamp01(s)
		if labels[i] {
			sumLabel[b]++
		}
	}
	for b := range out {
		if out[b].Count > 0 {
			out[b].MeanScore = sumScore[b] / float64(out[b].Count)
			out[b].MeanLabel = float64(sumLabel[b]) / float64(out[b].Count)
		}
	}
	return out
}

// ExpectedCalibrationError is the count-weighted mean gap between confidence and
// accuracy across bins (Naeini et al. 2015). 0 == perfectly calibrated; the CI
// gate fails when ECE exceeds its threshold (e.g. 0.05). A bucket of edges scored
// ~0.8 must resolve to ~80% true links.
func ExpectedCalibrationError(scores []float64, labels []bool, bins int) float64 {
	n := len(scores)
	if n == 0 {
		return 0
	}
	ece := 0.0
	for _, b := range ReliabilityDiagram(scores, labels, bins) {
		if b.Count == 0 {
			continue
		}
		ece += (float64(b.Count) / float64(n)) * math.Abs(b.MeanLabel-b.MeanScore)
	}
	return ece
}

// AUC is the area under the ROC curve via the Mann–Whitney U statistic
// (probability a random positive outscores a random negative), tie-aware using
// average ranks. Returns 0.5 when either class is empty (no discrimination
// possible). 1.0 == perfectly separable.
func AUC(scores []float64, labels []bool) float64 {
	type sl struct {
		score float64
		label bool
	}
	rows := make([]sl, len(scores))
	for i := range scores {
		rows[i] = sl{scores[i], labels[i]}
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].score < rows[j].score })

	// Average ranks (1-based), splitting ties evenly.
	ranks := make([]float64, len(rows))
	for i := 0; i < len(rows); {
		j := i
		for j < len(rows) && rows[j].score == rows[i].score {
			j++
		}
		avg := float64(i+j+1) / 2.0 // mean of ranks (i+1)..j
		for k := i; k < j; k++ {
			ranks[k] = avg
		}
		i = j
	}

	var sumRankPos, nPos, nNeg float64
	for i, r := range rows {
		if r.label {
			nPos++
			sumRankPos += ranks[i]
		} else {
			nNeg++
		}
	}
	if nPos == 0 || nNeg == 0 {
		return 0.5
	}
	return (sumRankPos - nPos*(nPos+1)/2) / (nPos * nNeg)
}

// PrecisionAtThreshold reports the precision (true links / predicted-positive) and
// the predicted-positive count for predictions at or above threshold. The engine
// tracks precision@high-confidence (≥0.9) as a regression gate. Precision is 0
// when nothing clears the threshold.
func PrecisionAtThreshold(scores []float64, labels []bool, threshold float64) (precision float64, predictedPositive int) {
	truePos := 0
	for i, s := range scores {
		if s >= threshold {
			predictedPositive++
			if labels[i] {
				truePos++
			}
		}
	}
	if predictedPositive == 0 {
		return 0, 0
	}
	return float64(truePos) / float64(predictedPositive), predictedPositive
}

func binIndex(s float64, bins int) int {
	b := int(clamp01(s) * float64(bins))
	if b >= bins { // s == 1.0 lands in the top bin
		b = bins - 1
	}
	return b
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
