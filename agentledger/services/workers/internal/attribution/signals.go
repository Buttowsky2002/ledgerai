package attribution

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// Signal-extraction framework (build-plan sub-phase 3.2). Each signal is an
// independent, deterministic, explainable extractor: given one (outcome, run)
// candidate it returns a normalized value in [0,1] plus an evidence REFERENCE.
// The probabilistic scorer (3.3) combines them as prior + Σ(weight × value); it
// consumes []SignalResult generically and never enumerates signals by name, so
// ADDING a signal means appending to DefaultSignals — the scorer is untouched.
//
// SECURITY: signals read METADATA only — timestamps, ids, the run's stated
// objective, and a connector-supplied artifact-overlap fraction. No signal ever
// reads raw prompt/completion (or PR/commit/ticket body) content (CLAUDE.md
// rule 2; build-plan §7 — metadata and categorical evidence only).

// Signal type tags (mirror attribution_signals.signal_type).
const (
	SignalTypeTemporal   = "temporal"
	SignalTypeIdentity   = "identity"
	SignalTypeArtifact   = "artifact"
	SignalTypeContent    = "content"
	SignalTypeBehavioral = "behavioral"
)

// SignalConfig holds the hand-set, literature-informed constants the signals use
// until the flywheel (3.6) refits them. Per-outcome-type temporal decay reflects
// that a pr_merged lands minutes after a coding session while a ticket_resolved
// can lag hours — a single global window would mis-score both.
type SignalConfig struct {
	TemporalHalfLife map[string]time.Duration // per outcome_type
	DefaultHalfLife  time.Duration            // fallback when the type is unknown
	BehavioralWindow time.Duration            // "right after the session ended"
}

// DefaultSignalConfig returns the hand-set priors used before any refit.
func DefaultSignalConfig() SignalConfig {
	return SignalConfig{
		TemporalHalfLife: map[string]time.Duration{
			"pr_merged":       30 * time.Minute,
			"issue_closed":    60 * time.Minute,
			"ticket_resolved": 120 * time.Minute,
			"qualified_lead":  240 * time.Minute,
		},
		DefaultHalfLife:  60 * time.Minute,
		BehavioralWindow: 15 * time.Minute,
	}
}

// SignalInput is everything a signal may read about one candidate. Metadata only.
type SignalInput struct {
	Outcome OutcomeRow
	Run     RunRow
	Config  SignalConfig
	// ArtifactOverlap is the fraction [0,1] of the outcome's artifacts (files) also
	// touched by the run, when a connector supplies it; nil means no artifact data
	// (the signal abstains). Connector seam — documented per CLAUDE.md rule 15.
	ArtifactOverlap *float64
}

// SignalResult is one signal's normalized value plus the evidence that explains
// it (references only; powers the audit UI and the scorer's contribution breakdown).
type SignalResult struct {
	Name     string  `json:"signal"`
	Type     string  `json:"signal_type"`
	Value    float64 `json:"value"` // normalized to [0,1]
	Evidence string  `json:"evidence_ref,omitempty"`
}

// Signal is one named extractor in the registry.
type Signal struct {
	Name string
	Type string
	Fn   func(SignalInput) SignalResult
}

// DefaultSignals is the extractor registry. Stable order → reproducible
// signal_contributions. Append here to add a signal (the scorer is generic).
func DefaultSignals() []Signal {
	return []Signal{
		{"temporal_proximity", SignalTypeTemporal, signalTemporal},
		{"identity_match", SignalTypeIdentity, signalIdentity},
		{"content_match", SignalTypeContent, signalContent},
		{"behavioral_followup", SignalTypeBehavioral, signalBehavioral},
		{"artifact_overlap", SignalTypeArtifact, signalArtifact},
	}
}

// ExtractSignals runs every registered signal over a candidate and returns the
// results in registry order. Deterministic: same input → same output.
func ExtractSignals(in SignalInput) []SignalResult {
	sigs := DefaultSignals()
	out := make([]SignalResult, 0, len(sigs))
	for _, s := range sigs {
		r := s.Fn(in)
		r.Name, r.Type = s.Name, s.Type
		out = append(out, r)
	}
	return out
}

// signalTemporal: exponential decay of the run→outcome gap, with a per-outcome-type
// half-life. 1.0 at zero gap, 0.5 at one half-life. Zero when the outcome predates
// the run end (a run cannot produce an outcome that already happened) or the
// timestamps are unparseable.
func signalTemporal(in SignalInput) SignalResult {
	dt, ok := candidateGap(in)
	if !ok || dt < 0 {
		return SignalResult{Value: 0, Evidence: "no temporal overlap"}
	}
	tau := in.Config.DefaultHalfLife
	if h, ok := in.Config.TemporalHalfLife[in.Outcome.OutcomeType]; ok && h > 0 {
		tau = h
	}
	if tau <= 0 {
		tau = time.Hour
	}
	v := math.Pow(0.5, float64(dt)/float64(tau))
	return SignalResult{Value: v, Evidence: fmt.Sprintf("gap=%s halflife=%s", dt.Round(time.Second), tau)}
}

// signalIdentity: the run's operator is the outcome's owner. Exact user match → 1.
func signalIdentity(in SignalInput) SignalResult {
	if in.Run.UserID != "" && in.Run.UserID == in.Outcome.UserID {
		return SignalResult{Value: 1, Evidence: "user:" + in.Run.UserID}
	}
	return SignalResult{Value: 0, Evidence: "no identity match"}
}

// signalContent: the outcome key (ticket id / PR number / branch fragment) appears
// in the run's stated objective. Reuses the V1 token extraction.
func signalContent(in SignalInput) SignalResult {
	tokens := outcomeKeyTokens(in.Outcome.OutcomeID)
	if matched, tok := objectiveMatchToken(in.Run.Objective, tokens); matched {
		return SignalResult{Value: 1, Evidence: "objective references " + tok}
	}
	return SignalResult{Value: 0, Evidence: "no content match"}
}

// signalBehavioral: the outcome landed within the behavioral window right after
// the session ended (a crisp "committed just after the run" indicator).
func signalBehavioral(in SignalInput) SignalResult {
	dt, ok := candidateGap(in)
	if !ok || dt < 0 {
		return SignalResult{Value: 0, Evidence: "no follow-up"}
	}
	if dt <= in.Config.BehavioralWindow {
		return SignalResult{Value: 1, Evidence: fmt.Sprintf("outcome %s after session end", dt.Round(time.Second))}
	}
	return SignalResult{Value: 0, Evidence: fmt.Sprintf("gap %s exceeds %s window", dt.Round(time.Second), in.Config.BehavioralWindow)}
}

// signalArtifact: fraction of the outcome's files the run also touched. Abstains
// (value 0) when no connector supplied artifact data — never fabricates a signal.
func signalArtifact(in SignalInput) SignalResult {
	if in.ArtifactOverlap == nil {
		return SignalResult{Value: 0, Evidence: "no artifact data"}
	}
	v := clamp01(*in.ArtifactOverlap)
	return SignalResult{Value: v, Evidence: fmt.Sprintf("file overlap %.0f%%", v*100)}
}

// candidateGap is outcome.ts − run.ended_at (positive when the outcome follows the
// run). ok=false when either timestamp is unparseable.
func candidateGap(in SignalInput) (time.Duration, bool) {
	ots, err := time.Parse(chTime, in.Outcome.TS)
	if err != nil {
		return 0, false
	}
	ended, err := time.Parse(chTime, in.Run.EndedAt)
	if err != nil {
		return 0, false
	}
	return ots.Sub(ended), true
}

// objectiveMatchToken reports the first outcome-key token found in the objective,
// for explainable content evidence (a tokenized variant of the V1 objectiveHasToken).
func objectiveMatchToken(objective string, tokens []string) (bool, string) {
	if objective == "" || len(tokens) == 0 {
		return false, ""
	}
	obj := strings.ToLower(objective)
	for _, t := range tokens {
		if strings.Contains(obj, strings.ToLower(t)) {
			return true, t
		}
	}
	return false, ""
}
