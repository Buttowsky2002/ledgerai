package attrpriors

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/agentledger/workers/internal/attribution"
)

// chLayout is the timestamp layout ClickHouse toString() emits (mirrors
// attribution's internal layout).
const chLayout = "2006-01-02 15:04:05.000"

// CHReader is the ClickHouse surface the flywheel reads (attribution.HTTPClient
// implements it).
type CHReader interface {
	FetchOutcomes(ctx context.Context, since string) ([]attribution.OutcomeRow, error)
	FetchRuns(ctx context.Context, since string) ([]attribution.RunRow, error)
}

// PriorStore is the Postgres surface the flywheel writes (attribution.PG implements it).
type PriorStore interface {
	ListOptedInTenants(ctx context.Context) ([]string, error)
	EnsureModelVersion(ctx context.Context, mv attribution.ModelVersion) error
	UpsertPriors(ctx context.Context, priors []attribution.Prior) error
}

// Metrics counts flywheel passes (atomic).
type Metrics struct {
	Passes      atomic.Int64
	OptedIn     atomic.Int64 // opted-in tenants seen on the last pass
	Contributed atomic.Int64 // tenants that contributed labeled data
	Produced    atomic.Int64 // passes that emitted priors (cleared the gate)
}

// Runner is the attribution-priors worker core.
type Runner struct {
	ch           CHReader
	pg           PriorStore
	window       time.Duration
	lookbackDays int
	minCustomerN int
	config       attribution.SignalConfig
	metrics      *Metrics
	now          func() time.Time
}

// NewRunner builds the flywheel runner.
func NewRunner(ch CHReader, pg PriorStore, window time.Duration, lookbackDays, minCustomerN int, m *Metrics) *Runner {
	if m == nil {
		m = &Metrics{}
	}
	if minCustomerN <= 0 {
		minCustomerN = DefaultMinCustomerN
	}
	return &Runner{
		ch: ch, pg: pg, window: window, lookbackDays: lookbackDays, minCustomerN: minCustomerN,
		config: attribution.DefaultSignalConfig(), metrics: m, now: time.Now,
	}
}

// Run performs one flywheel pass: gather opted-in tenants' deterministic-labeled
// data, aggregate anonymized priors (gated), and persist them.
func (r *Runner) Run(ctx context.Context) error {
	r.metrics.Passes.Add(1)
	now := r.now().UTC()
	outcomeSince := now.AddDate(0, 0, -r.lookbackDays).Format(chLayout)
	runSince := now.AddDate(0, 0, -r.lookbackDays).Add(-r.window).Format(chLayout)

	opted, err := r.pg.ListOptedInTenants(ctx)
	if err != nil {
		return err
	}
	optedSet := make(map[string]bool, len(opted))
	for _, t := range opted {
		optedSet[t] = true
	}
	r.metrics.OptedIn.Store(int64(len(opted)))

	outcomes, err := r.ch.FetchOutcomes(ctx, outcomeSince)
	if err != nil {
		return err
	}
	runs, err := r.ch.FetchRuns(ctx, runSince)
	if err != nil {
		return err
	}

	perTenant := r.buildSamples(outcomes, runs, optedSet)
	res := AggregatePriors(perTenant, r.minCustomerN)
	r.metrics.Contributed.Store(int64(res.ContributingTenants))

	if !res.Produced {
		slog.Info("attribution flywheel: below min_customer_n, no priors emitted",
			"contributing_tenants", res.ContributingTenants, "min_customer_n", r.minCustomerN)
		return nil
	}

	// Register the pooled global scorer lineage, then write the anonymized priors.
	if err := r.pg.EnsureModelVersion(ctx, priorModelVersion(res)); err != nil {
		return err
	}
	if err := r.pg.UpsertPriors(ctx, ToPriorRows(res)); err != nil {
		return err
	}
	r.metrics.Produced.Add(1)
	slog.Info("attribution flywheel: priors updated",
		"contributing_tenants", res.ContributingTenants, "outcome_types", len(res.TemporalHalfLife))
	return nil
}

// buildSamples derives deterministic-labeled training samples per opted-in tenant:
// a positive for each outcome with a hard link, and negatives from the other
// in-window candidate runs. Outcomes with no deterministic link are unlabeled and
// skipped (the semi-supervised design — §3.3).
func (r *Runner) buildSamples(outcomes []attribution.OutcomeRow, runs []attribution.RunRow, opted map[string]bool) map[string]TenantSamples {
	runsByTenant := make(map[string][]attribution.RunRow)
	for _, run := range runs {
		if opted[run.TenantID] {
			runsByTenant[run.TenantID] = append(runsByTenant[run.TenantID], run)
		}
	}
	per := make(map[string]TenantSamples)
	ensure := func(t string) TenantSamples {
		ts, ok := per[t]
		if !ok {
			ts = TenantSamples{Gaps: map[string][]time.Duration{}}
		}
		return ts
	}
	for _, o := range outcomes {
		if !opted[o.TenantID] {
			continue
		}
		tRuns := runsByTenant[o.TenantID]
		link, ok := attribution.ResolveDeterministic(o, tRuns, nil)
		if !ok {
			continue // unlabeled
		}
		ts := ensure(o.TenantID)
		// Positive: the linked run.
		for _, run := range tRuns {
			if run.RunID != link.RunID {
				continue
			}
			ts.Samples = append(ts.Samples, attribution.FitSample{
				Signals: attribution.ExtractSignals(attribution.SignalInput{Outcome: o, Run: run, Config: r.config}),
				Label:   true,
			})
			if gap, ok := positiveGap(o, run); ok {
				ts.Gaps[o.OutcomeType] = append(ts.Gaps[o.OutcomeType], gap)
			}
		}
		// Negatives: other in-window runs that did NOT produce the outcome.
		for _, run := range tRuns {
			if run.RunID == link.RunID {
				continue
			}
			gap, ok := positiveGap(o, run)
			if !ok || gap < 0 || gap > r.window {
				continue
			}
			ts.Samples = append(ts.Samples, attribution.FitSample{
				Signals: attribution.ExtractSignals(attribution.SignalInput{Outcome: o, Run: run, Config: r.config}),
				Label:   false,
			})
		}
		per[o.TenantID] = ts
	}
	return per
}

// positiveGap is outcome.ts − run.ended_at.
func positiveGap(o attribution.OutcomeRow, run attribution.RunRow) (time.Duration, bool) {
	ots, err := time.Parse(chLayout, o.TS)
	if err != nil {
		return 0, false
	}
	ended, err := time.Parse(chLayout, run.EndedAt)
	if err != nil {
		return 0, false
	}
	return ots.Sub(ended), true
}

// priorModelVersion is the lineage row for the pooled global scorer.
func priorModelVersion(res PriorResult) attribution.ModelVersion {
	params, _ := json.Marshal(res.Model)
	metrics, _ := json.Marshal(map[string]int{"contributing_tenants": res.ContributingTenants})
	return attribution.ModelVersion{
		Version: PriorScorerVersion, Kind: "priors", Params: params, Metrics: metrics, Active: true,
	}
}
