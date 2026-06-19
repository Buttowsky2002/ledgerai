package reconcile

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"
)

// Metrics holds reconciliation counters (atomic).
type Metrics struct {
	Reconciled atomic.Int64 // adjustment rows booked
	Flagged    atomic.Int64 // rows exceeding the drift threshold
	Runs       atomic.Int64
}

// Reconciler books one cost_adjustment per (tenant, day, model) from the
// reconciliation view and flags material drift.
type Reconciler struct {
	ch        CHClient
	threshold float64 // e.g. 0.02 == 2%
	lookback  int     // days back to reconcile each run
	metrics   *Metrics
	now       func() time.Time
}

func New(ch CHClient, threshold float64, lookbackDays int, m *Metrics) *Reconciler {
	if m == nil {
		m = &Metrics{}
	}
	return &Reconciler{ch: ch, threshold: threshold, lookback: lookbackDays, metrics: m, now: time.Now}
}

// Run performs one reconciliation pass over the last `lookback` days.
func (r *Reconciler) Run(ctx context.Context) error {
	r.metrics.Runs.Add(1)
	since := r.now().UTC().AddDate(0, 0, -r.lookback).Format("2006-01-02")

	rows, err := r.ch.Reconciliation(ctx, since)
	if err != nil {
		return err
	}

	stamp := r.now().UTC().Format("2006-01-02 15:04:05.000")
	adj := make([]Adjustment, 0, len(rows))
	flagged := 0
	for _, row := range rows {
		f := r.flag(row)
		if f == 1 {
			flagged++
		}
		adj = append(adj, Adjustment{
			TenantID:        row.TenantID,
			Day:             row.Day,
			Model:           row.Model,
			VirtualKeyID:    row.VirtualKeyID,
			GatewayCostUSD:  row.GatewayCostUSD,
			ProviderCostUSD: row.ProviderCostUSD,
			DriftUSD:        row.DriftUSD,
			DriftPct:        row.DriftPct,
			Flagged:         f,
			ThresholdPct:    r.threshold,
			ReconciledAt:    stamp,
		})
	}

	if err := r.ch.WriteAdjustments(ctx, adj); err != nil {
		return err
	}

	r.metrics.Reconciled.Add(int64(len(adj)))
	r.metrics.Flagged.Add(int64(flagged))
	slog.Info("reconciliation pass complete", "since", since, "rows", len(adj), "flagged", flagged)
	return nil
}

// flag marks a row when its absolute drift exceeds the threshold. Rows with no
// provider-billed cost (provider_cost_usd == 0) are never flagged: there is
// nothing to reconcile against (the connector hasn't imported that day yet).
func (r *Reconciler) flag(row ReconRow) uint8 {
	if row.ProviderCostUSD == 0 {
		return 0
	}
	if abs(row.DriftPct) > r.threshold {
		return 1
	}
	return 0
}
