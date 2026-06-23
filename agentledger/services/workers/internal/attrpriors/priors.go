// Package attrpriors is the attribution flywheel (build-plan sub-phase 3.6): the
// cross-customer prior aggregator that makes the engine self-improving. Nightly it
// pools the deterministic-labeled training data across OPTED-IN tenants and, only
// when at least min_customer_n distinct tenants contribute, fits ANONYMIZED
// aggregate priors — a global scorer (weights) and per-outcome-type temporal
// half-lives — that improve cold-start accuracy for a new tenant with no data.
//
// PRIVACY (CLAUDE.md §7 — absolute): priors are distributions/constants only,
// derived from ≥ min_customer_n tenants. No row-level, identifiable, or
// single-tenant-derivable value ever crosses a tenant boundary. The output table
// attribution_priors has NO tenant_id by construction (migration 010). Opt-out is
// honored upstream (the runner excludes opted-out tenants before pooling). See
// ADR-044.
package attrpriors

import (
	"encoding/json"
	"sort"
	"time"

	"github.com/agentledger/workers/internal/attribution"
)

// DefaultMinCustomerN is the privacy gate: a prior is only emitted when at least
// this many distinct tenants contributed to it (§7; start at 10).
const DefaultMinCustomerN = 10

// PriorScorerVersion is the model lineage id for the pooled global scorer.
const PriorScorerVersion = "prior-scorer-v1"

// TenantSamples is one tenant's contribution to the flywheel: its deterministic-
// labeled training samples and the positive-link gaps per outcome_type.
type TenantSamples struct {
	Samples []attribution.FitSample
	Gaps    map[string][]time.Duration
}

// PriorResult is one flywheel run's output.
type PriorResult struct {
	Produced            bool                     // false when gated below min_customer_n
	ContributingTenants int                      // distinct tenants that contributed
	Model               attribution.ScorerModel  // pooled global scorer (signal_weight prior)
	TemporalHalfLife    map[string]time.Duration // per outcome_type
}

// AggregatePriors pools opted-in tenants' samples and fits anonymized priors, gated
// by minCustomerN. Below the gate it returns Produced=false and NO model — the
// privacy guarantee is structural, not advisory.
func AggregatePriors(perTenant map[string]TenantSamples, minCustomerN int) PriorResult {
	var pooled []attribution.FitSample
	gaps := map[string][]time.Duration{}
	tenants := 0
	for _, ts := range perTenant {
		if len(ts.Samples) == 0 {
			continue
		}
		tenants++
		pooled = append(pooled, ts.Samples...)
		for ot, gs := range ts.Gaps {
			gaps[ot] = append(gaps[ot], gs...)
		}
	}
	if tenants < minCustomerN {
		return PriorResult{Produced: false, ContributingTenants: tenants}
	}

	model := attribution.FitScorer(PriorScorerVersion, pooled, attribution.DefaultFitOpts())
	model.Platt = attribution.FitPlatt(model, pooled, attribution.DefaultFitOpts())

	half := map[string]time.Duration{}
	for ot, gs := range gaps {
		if len(gs) > 0 {
			half[ot] = medianDuration(gs)
		}
	}
	return PriorResult{
		Produced: true, ContributingTenants: tenants,
		Model: model, TemporalHalfLife: half,
	}
}

// ToPriorRows renders a produced result as attribution_priors rows: one
// signal_weight prior (the pooled scorer) and one temporal_decay prior per
// outcome_type. Each row records the min_customer_n it was derived from.
func ToPriorRows(res PriorResult) []attribution.Prior {
	if !res.Produced {
		return nil
	}
	rows := make([]attribution.Prior, 0, 1+len(res.TemporalHalfLife))
	model, _ := json.Marshal(res.Model)
	rows = append(rows, attribution.Prior{
		PriorType: "signal_weight", Value: model,
		MinCustomerN: res.ContributingTenants, ModelVersion: PriorScorerVersion,
	})
	for ot, hl := range res.TemporalHalfLife {
		v, _ := json.Marshal(map[string]float64{"half_life_minutes": hl.Minutes()})
		rows = append(rows, attribution.Prior{
			PriorType: "temporal_decay", OutcomeType: ot, Value: v,
			MinCustomerN: res.ContributingTenants, ModelVersion: PriorScorerVersion,
		})
	}
	return rows
}

// medianDuration returns the median of a duration sample (a robust half-life
// estimator: decay reaches ~0.5 around the median run→outcome gap).
func medianDuration(d []time.Duration) time.Duration {
	cp := append([]time.Duration(nil), d...)
	sort.Slice(cp, func(i, j int) bool { return cp[i] < cp[j] })
	return cp[len(cp)/2]
}
