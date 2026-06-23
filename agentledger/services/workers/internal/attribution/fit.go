package attribution

// Semi-supervised weight fitting + calibration (build-plan sub-phase 3.3). The
// scorer's weights are initialized as hand-set priors, then fit via logistic
// regression against the deterministic LABELS from 3.1 (the build plan's
// self-improving seam): every deterministic edge is a labeled positive, and
// candidates that lost to a deterministic link are negatives.
//
// The fit is full-batch gradient descent — stdlib only (CLAUDE.md rule 12), NO
// randomness, fixed iteration count — so refitting is reproducible bit-for-bit
// (§3.3 acceptance) without a seed. Each fitted model is versioned in
// attribution_model_versions (ADR-040, rule 10).

// FitSample is one labeled training example: the extracted signals + ground truth.
type FitSample struct {
	Signals []SignalResult
	Label   bool
}

// FitOpts controls gradient descent. Defaults are tuned for the small label sets
// of early deployments; the flywheel (3.6) may scale iterations with data volume.
type FitOpts struct {
	Iterations   int
	LearningRate float64
	L2           float64 // ridge penalty (keeps weights finite on separable data)
}

// DefaultFitOpts returns the standard fit configuration.
func DefaultFitOpts() FitOpts {
	return FitOpts{Iterations: 2000, LearningRate: 0.5, L2: 1e-3}
}

// FitScorer fits per-signal weights + prior via logistic regression. Deterministic:
// same samples + opts → identical weights. Feature order follows DefaultSignals so
// the model is stable across runs.
func FitScorer(version string, samples []FitSample, opts FitOpts) ScorerModel {
	names := signalNames()
	w := make([]float64, len(names))
	bias := 0.0
	n := float64(len(samples))
	if n == 0 {
		return ScorerModel{Version: version, Prior: 0, Weights: map[string]float64{}}
	}

	x := make([][]float64, len(samples))
	y := make([]float64, len(samples))
	for i, s := range samples {
		x[i] = featureVector(s.Signals, names)
		if s.Label {
			y[i] = 1
		}
	}

	for it := 0; it < opts.Iterations; it++ {
		gb := 0.0
		gw := make([]float64, len(names))
		for i := range samples {
			z := bias
			for j := range names {
				z += w[j] * x[i][j]
			}
			err := sigmoid(z) - y[i]
			gb += err
			for j := range names {
				gw[j] += err * x[i][j]
			}
		}
		bias -= opts.LearningRate * gb / n
		for j := range names {
			w[j] -= opts.LearningRate * (gw[j]/n + opts.L2*w[j])
		}
	}

	weights := make(map[string]float64, len(names))
	for j, nm := range names {
		weights[nm] = w[j]
	}
	return ScorerModel{Version: version, Prior: bias, Weights: weights}
}

// FitPlatt fits a Platt calibrator (calibrated = sigmoid(A·raw + B)) so a reported
// 0.8 resolves to ~80% true links (§6). Deterministic full-batch GD over the raw
// scores the model already produces.
func FitPlatt(m ScorerModel, samples []FitSample, opts FitOpts) *PlattCalibrator {
	if len(samples) == 0 {
		return nil
	}
	raw := make([]float64, len(samples))
	y := make([]float64, len(samples))
	for i, s := range samples {
		r, _, _ := m.Score(s.Signals)
		raw[i] = r
		if s.Label {
			y[i] = 1
		}
	}
	a, b := 1.0, 0.0
	n := float64(len(samples))
	for it := 0; it < opts.Iterations; it++ {
		ga, gb := 0.0, 0.0
		for i := range samples {
			err := sigmoid(a*raw[i]+b) - y[i]
			ga += err * raw[i]
			gb += err
		}
		a -= opts.LearningRate * ga / n
		b -= opts.LearningRate * gb / n
	}
	return &PlattCalibrator{A: a, B: b}
}

// signalNames returns the registry's signal names in stable order.
func signalNames() []string {
	sigs := DefaultSignals()
	out := make([]string, len(sigs))
	for i, s := range sigs {
		out[i] = s.Name
	}
	return out
}

// featureVector maps a signal result set to a dense vector in names order
// (missing signals contribute 0).
func featureVector(signals []SignalResult, names []string) []float64 {
	byName := make(map[string]float64, len(signals))
	for _, s := range signals {
		byName[s.Name] = s.Value
	}
	v := make([]float64, len(names))
	for j, nm := range names {
		v[j] = byName[nm]
	}
	return v
}
