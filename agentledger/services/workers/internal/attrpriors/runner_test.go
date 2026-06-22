package attrpriors

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/agentledger/workers/internal/attribution"
)

type fakeCH struct {
	outcomes []attribution.OutcomeRow
	runs     []attribution.RunRow
}

func (f *fakeCH) FetchOutcomes(context.Context, string) ([]attribution.OutcomeRow, error) {
	return f.outcomes, nil
}
func (f *fakeCH) FetchRuns(context.Context, string) ([]attribution.RunRow, error) {
	return f.runs, nil
}

type fakeStore struct {
	opted    []string
	ensured  []attribution.ModelVersion
	priors   []attribution.Prior
	priorRun int
}

func (s *fakeStore) ListOptedInTenants(context.Context) ([]string, error) { return s.opted, nil }
func (s *fakeStore) EnsureModelVersion(_ context.Context, mv attribution.ModelVersion) error {
	s.ensured = append(s.ensured, mv)
	return nil
}
func (s *fakeStore) UpsertPriors(_ context.Context, p []attribution.Prior) error {
	s.priors = append(s.priors, p...)
	s.priorRun++
	return nil
}

// seedTenant creates one SDK-stamped (positive) outcome + run pair plus a nearby
// non-linking run (negative) for a tenant, so each tenant contributes labels.
func seedTenant(tenant string, n int) ([]attribution.OutcomeRow, []attribution.RunRow) {
	var os []attribution.OutcomeRow
	var rs []attribution.RunRow
	for i := 0; i < n; i++ {
		oid := "github:" + tenant + "/r#" + strconv.Itoa(i)
		os = append(os, attribution.OutcomeRow{
			OutcomeID: oid, TenantID: tenant, TS: "2026-06-10 10:00:00.000",
			SourceSystem: "github", OutcomeType: "pr_merged", UserID: "u" + strconv.Itoa(i),
		})
		rs = append(rs,
			attribution.RunRow{RunID: tenant + "-link-" + strconv.Itoa(i), TenantID: tenant, AgentID: "a",
				UserID: "u" + strconv.Itoa(i), EndedAt: "2026-06-10 09:50:00.000", OutcomeID: oid},
			attribution.RunRow{RunID: tenant + "-neg-" + strconv.Itoa(i), TenantID: tenant, AgentID: "b",
				UserID: "other", EndedAt: "2026-06-10 09:30:00.000"},
		)
	}
	return os, rs
}

func TestRunnerProducesPriorsAndHonorsOptOut(t *testing.T) {
	ch := &fakeCH{}
	var opted []string
	// 11 opted-in tenants contribute; one extra tenant is opted OUT (absent from
	// the opted list) and its data must be ignored.
	for i := 0; i < 11; i++ {
		tn := "t" + strconv.Itoa(i)
		opted = append(opted, tn)
		o, r := seedTenant(tn, 2)
		ch.outcomes = append(ch.outcomes, o...)
		ch.runs = append(ch.runs, r...)
	}
	optedOut, optedOutRuns := seedTenant("evil", 2) // NOT in opted list
	ch.outcomes = append(ch.outcomes, optedOut...)
	ch.runs = append(ch.runs, optedOutRuns...)

	store := &fakeStore{opted: opted}
	r := NewRunner(ch, store, 240*time.Minute, 90, DefaultMinCustomerN, nil)
	r.now = func() time.Time { return time.Date(2026, 6, 12, 0, 0, 0, 0, time.UTC) }
	if err := r.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}

	if store.priorRun != 1 || len(store.priors) == 0 {
		t.Fatalf("expected priors written once; runs=%d priors=%d", store.priorRun, len(store.priors))
	}
	// Contributing-tenant count excludes the opted-out tenant.
	if got := r.metrics.Contributed.Load(); got != 11 {
		t.Fatalf("contributing tenants = %d, want 11 (opted-out excluded)", got)
	}
	if got := r.metrics.Produced.Load(); got != 1 {
		t.Fatalf("produced passes = %d, want 1", got)
	}
	// The pooled scorer lineage was registered active.
	var sawPrior bool
	for _, mv := range store.ensured {
		if mv.Version == PriorScorerVersion && mv.Active {
			sawPrior = true
		}
	}
	if !sawPrior {
		t.Fatal("pooled scorer model version not registered active")
	}
}

func TestRunnerGatedBelowMinCustomerN(t *testing.T) {
	ch := &fakeCH{}
	var opted []string
	for i := 0; i < 8; i++ { // below the gate of 10
		tn := "t" + strconv.Itoa(i)
		opted = append(opted, tn)
		o, r := seedTenant(tn, 2)
		ch.outcomes = append(ch.outcomes, o...)
		ch.runs = append(ch.runs, r...)
	}
	store := &fakeStore{opted: opted}
	r := NewRunner(ch, store, 240*time.Minute, 90, DefaultMinCustomerN, nil)
	r.now = func() time.Time { return time.Date(2026, 6, 12, 0, 0, 0, 0, time.UTC) }
	if err := r.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(store.priors) != 0 || store.priorRun != 0 {
		t.Fatalf("no priors must be written below min_customer_n; got %d", len(store.priors))
	}
}
