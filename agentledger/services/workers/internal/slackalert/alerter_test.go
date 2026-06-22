package slackalert

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeBudgets struct{ b []Budget }

func (f fakeBudgets) Budgets(context.Context) ([]Budget, error) { return f.b, nil }

type fakeSpend struct {
	spend     map[string]float64
	events    []RiskEvent
	lastSince string
}

func (f *fakeSpend) ScopeSpend(_ context.Context, b Budget, _ string) (float64, error) {
	return f.spend[b.ScopeID], nil
}

func (f *fakeSpend) HighRiskEvents(_ context.Context, since string) ([]RiskEvent, error) {
	f.lastSince = since
	var out []RiskEvent
	for _, e := range f.events {
		if e.DetectedAt > since {
			out = append(out, e)
		}
	}
	return out, nil
}

type fakeSlack struct {
	enabled  bool
	posted   []string
	failNext bool
}

func (f *fakeSlack) Enabled() bool { return f.enabled }
func (f *fakeSlack) Post(_ context.Context, text string) error {
	if f.failNext {
		f.failNext = false
		return errors.New("boom")
	}
	f.posted = append(f.posted, text)
	return nil
}

func fixedNow() time.Time { return time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC) }

func mustRun(t *testing.T, a *Alerter) {
	t.Helper()
	if err := a.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestHighestCrossed(t *testing.T) {
	cases := []struct {
		pcts []int
		pct  int
		want int
	}{
		{[]int{50, 80, 100}, 85, 80},
		{[]int{50, 80, 100}, 49, 0},
		{[]int{50, 80, 100}, 100, 100},
		{[]int{100, 50, 80}, 120, 100}, // unsorted input
	}
	for _, c := range cases {
		if got := highestCrossed(c.pcts, c.pct); got != c.want {
			t.Errorf("highestCrossed(%v, %d) = %d, want %d", c.pcts, c.pct, got, c.want)
		}
	}
}

func TestDisabledIsNoOp(t *testing.T) {
	slack := &fakeSlack{enabled: false}
	a := New(fakeBudgets{}, &fakeSpend{}, slack, &Metrics{}, fixedNow)
	if err := a.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(slack.posted) != 0 {
		t.Fatalf("disabled alerter should post nothing, got %d", len(slack.posted))
	}
}

func TestBudgetBreachAlertsOnceThenDedupes(t *testing.T) {
	budgets := fakeBudgets{b: []Budget{
		{BudgetID: "b1", TenantID: "t1", ScopeType: "team", ScopeID: "eng", Period: "monthly", AmountUSD: 100, AlertPcts: []int{50, 80, 100}},
	}}
	spend := &fakeSpend{spend: map[string]float64{"eng": 85}} // 85% → crosses 80
	slack := &fakeSlack{enabled: true}
	m := &Metrics{}
	a := New(budgets, spend, slack, m, fixedNow)

	mustRun(t, a)
	if len(slack.posted) != 1 {
		t.Fatalf("expected 1 budget alert, got %d", len(slack.posted))
	}
	// Same spend → no re-alert (dedupe within the month).
	mustRun(t, a)
	if len(slack.posted) != 1 {
		t.Fatalf("expected no re-alert, got %d", len(slack.posted))
	}
	// Spend now crosses 100 → one more alert.
	spend.spend["eng"] = 105
	mustRun(t, a)
	if len(slack.posted) != 2 {
		t.Fatalf("expected a 100%% alert, got %d posts", len(slack.posted))
	}
	if m.BudgetBreaches.Load() != 2 {
		t.Fatalf("budget breaches metric = %d, want 2", m.BudgetBreaches.Load())
	}
}

func TestRiskEventsAlertOnceViaHighWaterMark(t *testing.T) {
	spend := &fakeSpend{events: []RiskEvent{
		{EventID: "e1", TenantID: "t1", AgentID: "a1", Category: "unauthorized_tool", Severity: "high", Detail: "rm -rf", DetectedAt: "2026-06-15 12:00:01"},
		{EventID: "e2", TenantID: "t1", AgentID: "a1", Category: "tool_spike", Severity: "high", Detail: "spike", DetectedAt: "2026-06-15 12:00:02"},
	}}
	slack := &fakeSlack{enabled: true}
	m := &Metrics{}
	a := New(fakeBudgets{}, spend, slack, m, fixedNow)

	mustRun(t, a)
	if len(slack.posted) != 2 {
		t.Fatalf("expected 2 risk alerts, got %d", len(slack.posted))
	}
	// High-water mark advanced past both → next pass alerts nothing.
	mustRun(t, a)
	if len(slack.posted) != 2 {
		t.Fatalf("expected no re-alert of seen events, got %d", len(slack.posted))
	}
	if m.RiskEvents.Load() != 2 {
		t.Fatalf("risk events metric = %d, want 2", m.RiskEvents.Load())
	}
}

func TestSlackFailureCounted(t *testing.T) {
	spend := &fakeSpend{events: []RiskEvent{
		{EventID: "e1", Severity: "high", Category: "x", AgentID: "a", Detail: "d", DetectedAt: "2026-06-15 12:00:01"},
	}}
	slack := &fakeSlack{enabled: true, failNext: true}
	m := &Metrics{}
	a := New(fakeBudgets{}, spend, slack, m, fixedNow)
	mustRun(t, a)
	if m.AlertsFailed.Load() != 1 {
		t.Fatalf("expected 1 failed alert, got %d", m.AlertsFailed.Load())
	}
}
