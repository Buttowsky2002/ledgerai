package attribution

import (
	"math"
	"strings"
)

// Counterfactual baseline layer (build-plan sub-phase 3.4). Raw attribution credits
// an agent with the GROSS outcome value; finance needs the INCREMENTAL value — the
// share that would NOT have happened without the agent. We estimate, per identity
// (falling back to team), the fraction of that subject's outcomes produced WITHOUT
// an agent (the baseline), and scale value by the complementary incremental
// fraction (counterfactual_delta). A developer who already ships a lot unassisted
// earns less incremental credit for an agent-assisted outcome — the result that
// survives CFO scrutiny (§3.4).
//
// This v1 is a SHARE-based estimator (delta = 1 − baseline_share). The rate-based
// difference-in-differences refinement over pre-adoption windows is the documented
// next step (ADR-042), left to the flywheel (3.6). Every baseline carries its
// validity checks (overlap, placebo, sensitivity) as caveats — never silent
// assumptions (§3.4, §7).

const (
	// baselineMinSample is the minimum outcomes in an identity/team+type group
	// before its baseline is trusted; below it the engine falls back
	// (identity → team → conservative full credit).
	baselineMinSample = 4
	// sensitivityTol flags a baseline whose delta shifts more than this under a
	// +1 Laplace perturbation of the baseline count (small, noisy samples).
	sensitivityTol = 0.2
)

// Baseline scopes.
const (
	ScopeIdentity = "identity"
	ScopeTeam     = "team"
)

// Baseline is one computed counterfactual baseline for a (scope, subject,
// outcome_type) group over the pass window.
type Baseline struct {
	TenantID      string
	Scope         string
	SubjectID     string
	OutcomeType   string
	BaselineCount int     // outcomes with NO agent link (the unassisted proxy)
	TotalCount    int     // all outcomes by this subject + type in the window
	Delta         float64 // incremental fraction in [0,1]
	Checks        ConfounderChecks
	WindowStart   string // set by the engine at persist time
	WindowEnd     string
}

// BaselineRate is the unassisted share (what gets stored in attribution_baselines).
func (b Baseline) BaselineRate() float64 {
	if b.TotalCount == 0 {
		return 0
	}
	return float64(b.BaselineCount) / float64(b.TotalCount)
}

// ConfounderChecks records the validity caveats for a baseline (stored as
// attribution_baselines.confounder_checks; shown in the audit UI, never silent).
type ConfounderChecks struct {
	Overlap     bool     `json:"overlap"`     // sample adequate to compare cohorts
	Placebo     bool     `json:"placebo"`     // baseline actually observed (not unobserved)
	Sensitivity bool     `json:"sensitivity"` // delta stable under perturbation
	Caveats     []string `json:"caveats,omitempty"`
	BaselineN   int      `json:"baseline_count"`
	TotalN      int      `json:"total_count"`
}

// ComputeBaselines builds identity- and team-scoped baselines from the outcomes in
// the window, given the set of treated outcome keys (tenant\x00outcome_id) the
// engine attributed to an agent this pass. Deterministic.
func ComputeBaselines(outcomes []OutcomeRow, treated map[string]bool) map[string]Baseline {
	type acc struct{ total, baseline int }
	groups := map[string]*acc{}
	bump := func(tenant, scope, subj, typ string, isTreated bool) {
		if subj == "" {
			return // cannot baseline an unknown subject
		}
		k := baselineKey(tenant, scope, subj, typ)
		a := groups[k]
		if a == nil {
			a = &acc{}
			groups[k] = a
		}
		a.total++
		if !isTreated {
			a.baseline++
		}
	}
	for _, o := range outcomes {
		isT := treated[o.TenantID+"\x00"+o.OutcomeID]
		bump(o.TenantID, ScopeIdentity, o.UserID, o.OutcomeType, isT)
		bump(o.TenantID, ScopeTeam, o.TeamID, o.OutcomeType, isT)
	}
	out := make(map[string]Baseline, len(groups))
	for k, a := range groups {
		p := strings.SplitN(k, "\x00", 4)
		b := Baseline{
			TenantID: p[0], Scope: p[1], SubjectID: p[2], OutcomeType: p[3],
			BaselineCount: a.baseline, TotalCount: a.total,
		}
		b.Delta, b.Checks = incrementalDelta(a.baseline, a.total)
		out[k] = b
	}
	return out
}

// incrementalDelta = clamp01(1 − baseline/total) with confounder checks.
func incrementalDelta(baseline, total int) (float64, ConfounderChecks) {
	checks := ConfounderChecks{BaselineN: baseline, TotalN: total}
	if total == 0 {
		checks.Caveats = []string{"no_outcomes"}
		return 1.0, checks
	}
	delta := clamp01(1.0 - float64(baseline)/float64(total))

	checks.Overlap = total >= baselineMinSample
	if !checks.Overlap {
		checks.Caveats = append(checks.Caveats, "overlap_insufficient")
	}
	checks.Placebo = baseline > 0 // the unassisted counterfactual was actually observed
	if !checks.Placebo {
		checks.Caveats = append(checks.Caveats, "baseline_unobserved")
	}
	deltaLaplace := clamp01(1.0 - float64(baseline+1)/float64(total+1))
	checks.Sensitivity = math.Abs(delta-deltaLaplace) <= sensitivityTol
	if !checks.Sensitivity {
		checks.Caveats = append(checks.Caveats, "high_sensitivity")
	}
	return delta, checks
}

// deltaFor returns the incremental delta to apply to an outcome's value, preferring
// the identity baseline, falling back to the team baseline, and — when neither has
// adequate overlap — to conservative FULL credit (delta 1.0) flagged "no_baseline"
// (we never fabricate a discount on an unestimable counterfactual). ok reports
// whether a trusted baseline was used.
func deltaFor(baselines map[string]Baseline, o OutcomeRow) (float64, ConfounderChecks, bool) {
	if b, ok := baselines[baselineKey(o.TenantID, ScopeIdentity, o.UserID, o.OutcomeType)]; ok && b.Checks.Overlap {
		return b.Delta, b.Checks, true
	}
	if b, ok := baselines[baselineKey(o.TenantID, ScopeTeam, o.TeamID, o.OutcomeType)]; ok && b.Checks.Overlap {
		return b.Delta, b.Checks, true
	}
	return 1.0, ConfounderChecks{Caveats: []string{"no_baseline"}}, false
}

func baselineKey(tenant, scope, subject, outcomeType string) string {
	return tenant + "\x00" + scope + "\x00" + subject + "\x00" + outcomeType
}
