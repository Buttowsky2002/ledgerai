package attribution

import "math"

// Probabilistic scorer (build-plan sub-phase 3.3). A log-linear (logistic) model:
//
//	logit = prior + Σ (signal_weight × signal_value)
//	confidence_raw = sigmoid(logit)
//
// It is deliberately INTERPRETABLE — each signal's weighted log-odds IS its
// explanation (ADR-041). Every score carries a complete Contribution breakdown,
// persisted as signal_contributions on the edge; a score without its explanation
// is worthless (§3.3, non-negotiable).
//
// confidence_calibrated maps raw → a calibrated probability via an optional Platt
// calibrator (fitted in fit.go / refit by the flywheel, 3.6); absent it is the
// identity, so a deployment with no calibrator still produces a usable raw score.

// Contribution is one signal's role in a probabilistic score — value, the weight
// applied, the resulting log-odds, and the evidence reference. This is what the
// audit UI renders.
type Contribution struct {
	Signal          string  `json:"signal"`
	Type            string  `json:"signal_type,omitempty"`
	Value           float64 `json:"value"`
	Weight          float64 `json:"weight"`
	WeightedLogOdds float64 `json:"weighted_log_odds"`
	EvidenceRef     string  `json:"evidence_ref,omitempty"`
}

// PlattCalibrator maps a raw confidence to a calibrated one: sigmoid(A·raw + B).
type PlattCalibrator struct {
	A float64 `json:"a"`
	B float64 `json:"b"`
}

// Apply maps a raw confidence through the calibrator.
func (c PlattCalibrator) Apply(raw float64) float64 { return sigmoid(c.A*raw + c.B) }

// ScorerModel is the fitted (or hand-set) log-linear model plus its optional
// calibrator. Persisted to attribution_model_versions so any score is reproducible.
type ScorerModel struct {
	Version string             `json:"version"`
	Prior   float64            `json:"prior"`   // bias log-odds (base rate)
	Weights map[string]float64 `json:"weights"` // per-signal-name weight
	Platt   *PlattCalibrator   `json:"platt,omitempty"`
}

// Score combines the extracted signals into raw + calibrated confidence and the
// per-signal contribution breakdown (in the order signals were given).
func (m ScorerModel) Score(signals []SignalResult) (raw, calibrated float64, contribs []Contribution) {
	logit := m.Prior
	contribs = make([]Contribution, 0, len(signals))
	for _, s := range signals {
		w := m.Weights[s.Name]
		wl := w * s.Value
		logit += wl
		contribs = append(contribs, Contribution{
			Signal: s.Name, Type: s.Type, Value: s.Value,
			Weight: w, WeightedLogOdds: wl, EvidenceRef: s.Evidence,
		})
	}
	raw = sigmoid(logit)
	calibrated = raw
	if m.Platt != nil {
		calibrated = m.Platt.Apply(raw)
	}
	return raw, calibrated, contribs
}

// DefaultScorerModel is the hand-set, literature-informed prior used before any
// fit (cold start — build-plan §10). The flywheel (3.6) refits these from labels.
// Weights are log-odds per unit signal value; the prior encodes a low base rate.
func DefaultScorerModel() ScorerModel {
	return ScorerModel{
		Version: "scorer-prior-v1",
		Prior:   -3.0,
		Weights: map[string]float64{
			"temporal_proximity":  3.0,
			"identity_match":      2.5,
			"content_match":       2.5,
			"behavioral_followup": 1.5,
			"artifact_overlap":    1.5,
		},
	}
}

func sigmoid(x float64) float64 { return 1.0 / (1.0 + math.Exp(-x)) }
