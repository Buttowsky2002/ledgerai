package attrpriors

import (
	"strconv"
	"testing"
	"time"

	"github.com/badgeriq/workers/internal/attribution"
)

// tenantSamples builds one synthetic tenant's labeled samples from a golden corpus.
func tenantSamples(seed int64, scale int) TenantSamples {
	pairs := attribution.GenerateGolden(seed, attribution.GoldenOptions{Scale: scale})
	ts := TenantSamples{Gaps: map[string][]time.Duration{}}
	for _, p := range pairs {
		sigs := attribution.ExtractSignals(attribution.SignalInput{
			Outcome: p.Outcome, Run: p.Run, Config: attribution.DefaultSignalConfig(),
		})
		ts.Samples = append(ts.Samples, attribution.FitSample{Signals: sigs, Label: p.IsLinked})
	}
	return ts
}

// evalAUC scores a held-out corpus with the hybrid path (deterministic resolver →
// scorer) and returns AUC against the true labels.
func evalAUC(model attribution.ScorerModel, pairs []attribution.LabeledPair) float64 {
	scores := make([]float64, len(pairs))
	labels := make([]bool, len(pairs))
	for i, p := range pairs {
		if link, ok := attribution.ResolveDeterministic(p.Outcome, []attribution.RunRow{p.Run}, nil); ok {
			scores[i] = link.Confidence
		} else {
			_, cal, _ := model.Score(attribution.ExtractSignals(attribution.SignalInput{
				Outcome: p.Outcome, Run: p.Run, Config: attribution.DefaultSignalConfig(),
			}))
			scores[i] = cal
		}
		labels[i] = p.IsLinked
	}
	return attribution.AUC(scores, labels)
}

// TestAggregatePriorsColdStartLift is the §3.6 acceptance: industry priors fitted
// from ≥ min_customer_n tenants measurably improve cold-start accuracy for a
// held-out tenant versus the hand-set default (which a brand-new tenant would use).
func TestAggregatePriorsColdStartLift(t *testing.T) {
	per := map[string]TenantSamples{}
	for i := 0; i < 12; i++ {
		per[strconv.Itoa(i)] = tenantSamples(int64(i+1), 2)
	}
	res := AggregatePriors(per, DefaultMinCustomerN)
	if !res.Produced {
		t.Fatal("expected priors to be produced with 12 contributing tenants")
	}
	if res.ContributingTenants != 12 {
		t.Fatalf("contributing tenants = %d, want 12", res.ContributingTenants)
	}

	holdout := attribution.GenerateGolden(99, attribution.GoldenOptions{Scale: 3})
	priorAUC := evalAUC(res.Model, holdout)
	defaultAUC := evalAUC(attribution.DefaultScorerModel(), holdout)
	t.Logf("cold-start AUC: prior=%.4f default=%.4f", priorAUC, defaultAUC)
	if priorAUC < defaultAUC {
		t.Fatalf("prior model (%.4f) should not regress the hand-set default (%.4f) on cold start", priorAUC, defaultAUC)
	}
}

// TestAggregatePriorsGate: below min_customer_n, NO priors are produced — the
// privacy guarantee is structural (§7).
func TestAggregatePriorsGate(t *testing.T) {
	per := map[string]TenantSamples{}
	for i := 0; i < 9; i++ {
		per[strconv.Itoa(i)] = tenantSamples(int64(i+1), 1)
	}
	res := AggregatePriors(per, DefaultMinCustomerN)
	if res.Produced {
		t.Fatalf("priors must not be produced with %d tenants (< %d)", res.ContributingTenants, DefaultMinCustomerN)
	}
	if rows := ToPriorRows(res); rows != nil {
		t.Fatalf("gated result must yield no prior rows, got %d", len(rows))
	}
	// Empty-tenant contributions don't count toward the gate.
	per["empty"] = TenantSamples{}
	if AggregatePriors(per, DefaultMinCustomerN).ContributingTenants != 9 {
		t.Fatal("empty tenant should not count toward the gate")
	}
}

func TestToPriorRows(t *testing.T) {
	per := map[string]TenantSamples{}
	for i := 0; i < 10; i++ {
		ts := tenantSamples(int64(i+1), 1)
		ts.Gaps["pr_merged"] = []time.Duration{20 * time.Minute, 40 * time.Minute, 30 * time.Minute}
		per[strconv.Itoa(i)] = ts
	}
	rows := ToPriorRows(AggregatePriors(per, DefaultMinCustomerN))
	if len(rows) == 0 {
		t.Fatal("expected prior rows")
	}
	var sawWeights, sawTemporal bool
	for _, r := range rows {
		if r.MinCustomerN != 10 {
			t.Fatalf("prior %s min_customer_n = %d, want 10", r.PriorType, r.MinCustomerN)
		}
		switch r.PriorType {
		case "signal_weight":
			sawWeights = true
		case "temporal_decay":
			sawTemporal = true
		}
	}
	if !sawWeights || !sawTemporal {
		t.Fatalf("want both signal_weight and temporal_decay priors; weights=%v temporal=%v", sawWeights, sawTemporal)
	}
}
