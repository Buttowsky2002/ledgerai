package reconcile

import (
	"context"
	"errors"
	"testing"
	"time"
)

type mockCH struct {
	rows      []ReconRow
	queryErr  error
	writeErr  error
	written   []Adjustment
	sinceSeen string
}

func (m *mockCH) Reconciliation(_ context.Context, since string) ([]ReconRow, error) {
	m.sinceSeen = since
	return m.rows, m.queryErr
}
func (m *mockCH) WriteAdjustments(_ context.Context, adj []Adjustment) error {
	if m.writeErr != nil {
		return m.writeErr
	}
	m.written = append(m.written, adj...)
	return nil
}

func fixedNow() func() time.Time {
	return func() time.Time { return time.Date(2026, 6, 16, 9, 0, 0, 0, time.UTC) }
}

func TestReconcileFlagsMaterialDrift(t *testing.T) {
	ch := &mockCH{rows: []ReconRow{
		{TenantID: "t1", Day: "2026-06-15", Model: "gpt-4o", GatewayCostUSD: 95, ProviderCostUSD: 100, DriftUSD: 5, DriftPct: 0.05},         // 5% → flag
		{TenantID: "t1", Day: "2026-06-15", Model: "gpt-4o-mini", GatewayCostUSD: 49.5, ProviderCostUSD: 50, DriftUSD: 0.5, DriftPct: 0.01}, // 1% → ok
		{TenantID: "t1", Day: "2026-06-16", Model: "claude", GatewayCostUSD: 10, ProviderCostUSD: 0, DriftUSD: -10, DriftPct: 0},            // no provider data → never flag
	}}
	m := &Metrics{}
	r := New(ch, 0.02, 35, m)
	r.now = fixedNow()

	if err := r.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(ch.written) != 3 {
		t.Fatalf("adjustments written = %d, want 3", len(ch.written))
	}
	if ch.sinceSeen != "2026-05-12" { // 2026-06-16 minus 35 days
		t.Fatalf("since = %q, want 2026-05-12", ch.sinceSeen)
	}
	if m.Flagged.Load() != 1 || m.Reconciled.Load() != 3 {
		t.Fatalf("metrics flagged=%d reconciled=%d, want 1/3", m.Flagged.Load(), m.Reconciled.Load())
	}
	// The 5% row is the only flagged one.
	for _, a := range ch.written {
		want := uint8(0)
		if a.Model == "gpt-4o" {
			want = 1
		}
		if a.Flagged != want {
			t.Errorf("model %s flagged=%d, want %d", a.Model, a.Flagged, want)
		}
		if a.ThresholdPct != 0.02 || a.ReconciledAt == "" {
			t.Errorf("adjustment missing threshold/timestamp: %+v", a)
		}
	}
}

func TestReconcilePreservesVirtualKey(t *testing.T) {
	// A keyed provider row (OpenAI project) and a key-less one (model-level)
	// must both book their virtual_key_id verbatim into the adjustment.
	ch := &mockCH{rows: []ReconRow{
		{TenantID: "t1", Day: "2026-06-15", Model: "gpt-4o", VirtualKeyID: "proj_abc", GatewayCostUSD: 100, ProviderCostUSD: 100, DriftPct: 0},
		{TenantID: "t1", Day: "2026-06-15", Model: "claude", VirtualKeyID: "", GatewayCostUSD: 50, ProviderCostUSD: 50, DriftPct: 0},
	}}
	r := New(ch, 0.02, 1, nil)
	r.now = fixedNow()
	if err := r.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, a := range ch.written {
		got[a.Model] = a.VirtualKeyID
	}
	if got["gpt-4o"] != "proj_abc" || got["claude"] != "" {
		t.Fatalf("virtual_key_id not preserved into adjustments: %+v", got)
	}
}

func TestReconcileThresholdBoundary(t *testing.T) {
	r := New(&mockCH{}, 0.02, 1, nil)
	cases := []struct {
		pct      float64
		provider float64
		want     uint8
	}{
		{0.02, 100, 0},   // exactly at threshold → not flagged (strictly greater)
		{0.0201, 100, 1}, // just over → flagged
		{-0.05, 100, 1},  // negative drift uses absolute value
		{0.9, 0, 0},      // no provider cost → never flagged
	}
	for _, c := range cases {
		got := r.flag(ReconRow{DriftPct: c.pct, ProviderCostUSD: c.provider})
		if got != c.want {
			t.Errorf("flag(pct=%v, provider=%v) = %d, want %d", c.pct, c.provider, got, c.want)
		}
	}
}

func TestReconcileQueryError(t *testing.T) {
	r := New(&mockCH{queryErr: errors.New("ch down")}, 0.02, 1, nil)
	r.now = fixedNow()
	if err := r.Run(context.Background()); err == nil {
		t.Fatal("expected error when query fails")
	}
}

func TestReconcileWriteError(t *testing.T) {
	r := New(&mockCH{rows: []ReconRow{{TenantID: "t1", ProviderCostUSD: 1, DriftPct: 0.5}}, writeErr: errors.New("insert failed")}, 0.02, 1, nil)
	r.now = fixedNow()
	if err := r.Run(context.Background()); err == nil {
		t.Fatal("expected error when write fails")
	}
}
