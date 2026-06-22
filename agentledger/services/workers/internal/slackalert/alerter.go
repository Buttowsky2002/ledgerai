// Package slackalert is the Slack alerting worker (Phase 6 F2). On a fixed
// interval it detects (a) budget-threshold breaches — current spend (ClickHouse)
// crossing a budget's configured alert_pcts (Postgres budgets) — and (b) critical
// risk events (risk_events severity=high), and posts them to a Slack webhook.
//
//	budgets (PG) + spend_daily/spend_hourly_by_key (CH) ┐
//	                                                     ├─▶ [slack-alerter] ─▶ Slack webhook
//	risk_events severity=high (CH)                       ┘
//
// Dedupe is in-memory (per process): each (budget, threshold, month) and each
// risk event alerts once; a restart re-arms from "now" so a backlog is not
// replayed (ADR-038). Webhook URL is an env-var name only (rule 1); unset =
// alerting disabled. Slack POST is stdlib net/http (no SDK, rule 12).
package slackalert

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Budget is one budget definition from Postgres.
type Budget struct {
	BudgetID  string
	TenantID  string
	ScopeType string // tenant|team|app|agent|key|model
	ScopeID   string
	Period    string // monthly|quarterly
	AmountUSD float64
	AlertPcts []int
	HardLimit bool
}

// RiskEvent is one critical (severity=high) governed risk event.
type RiskEvent struct {
	EventID    string `json:"event_id"`
	TenantID   string `json:"tenant_id"`
	AgentID    string `json:"agent_id"`
	Category   string `json:"category"`
	Severity   string `json:"severity"`
	Detail     string `json:"detail"`
	DetectedAt string `json:"detected_at"`
}

// BudgetSource reads budget definitions (Postgres, cross-tenant).
type BudgetSource interface {
	Budgets(ctx context.Context) ([]Budget, error)
}

// SpendSource reads current spend per budget scope and recent critical risk
// events (ClickHouse).
type SpendSource interface {
	ScopeSpend(ctx context.Context, b Budget, periodStart string) (float64, error)
	HighRiskEvents(ctx context.Context, since string) ([]RiskEvent, error)
}

// Notifier posts a message to Slack. Enabled() is false when no webhook is set.
type Notifier interface {
	Enabled() bool
	Post(ctx context.Context, text string) error
}

// Metrics are the worker's Prometheus counters.
type Metrics struct {
	Runs           atomic.Int64
	AlertsSent     atomic.Int64
	AlertsFailed   atomic.Int64
	BudgetBreaches atomic.Int64
	RiskEvents     atomic.Int64
}

// Alerter runs detection passes and posts alerts, de-duplicating in memory.
type Alerter struct {
	budgets BudgetSource
	spend   SpendSource
	slack   Notifier
	metrics *Metrics
	now     func() time.Time

	mu          sync.Mutex
	firedBudget map[string]int // "budgetID|YYYY-MM" → highest alert pct already sent
	lastRiskTS  string         // high-water mark on risk_events.detected_at
}

// New builds an Alerter. now defaults to time.Now; the risk high-water mark starts
// at "now" so the first pass does not replay the historical backlog.
func New(b BudgetSource, s SpendSource, slack Notifier, m *Metrics, now func() time.Time) *Alerter {
	if now == nil {
		now = time.Now
	}
	return &Alerter{
		budgets:     b,
		spend:       s,
		slack:       slack,
		metrics:     m,
		now:         now,
		firedBudget: make(map[string]int),
		lastRiskTS:  now().UTC().Format("2006-01-02 15:04:05"),
	}
}

// Run performs one detection + alert pass.
func (a *Alerter) Run(ctx context.Context) error {
	a.metrics.Runs.Add(1)
	if !a.slack.Enabled() {
		slog.Debug("slack alerting disabled (no webhook); skipping pass")
		return nil
	}
	a.checkBudgets(ctx)
	a.checkRiskEvents(ctx)
	return nil
}

func (a *Alerter) checkBudgets(ctx context.Context) {
	budgets, err := a.budgets.Budgets(ctx)
	if err != nil {
		slog.Error("load budgets failed", "err", err)
		return
	}
	month := a.now().UTC().Format("2006-01")
	periodStart := a.now().UTC().Format("2006-01") + "-01" // start of the current month
	for _, b := range budgets {
		if b.AmountUSD <= 0 || len(b.AlertPcts) == 0 {
			continue
		}
		spend, err := a.spend.ScopeSpend(ctx, b, periodStart)
		if err != nil {
			slog.Error("scope spend failed", "budget", b.BudgetID, "err", err)
			continue
		}
		pct := int(spend / b.AmountUSD * 100)
		crossed := highestCrossed(b.AlertPcts, pct)
		if crossed == 0 {
			continue
		}
		key := b.BudgetID + "|" + month
		a.mu.Lock()
		already := a.firedBudget[key]
		newCrossing := crossed > already
		if newCrossing {
			a.firedBudget[key] = crossed
		}
		a.mu.Unlock()
		if !newCrossing {
			continue
		}
		a.metrics.BudgetBreaches.Add(1)
		a.send(ctx, formatBudget(b, spend, pct, crossed))
	}
}

func (a *Alerter) checkRiskEvents(ctx context.Context) {
	a.mu.Lock()
	since := a.lastRiskTS
	a.mu.Unlock()

	events, err := a.spend.HighRiskEvents(ctx, since)
	if err != nil {
		slog.Error("load risk events failed", "err", err)
		return
	}
	maxTS := since
	for _, e := range events {
		a.metrics.RiskEvents.Add(1)
		a.send(ctx, formatRisk(e))
		if e.DetectedAt > maxTS {
			maxTS = e.DetectedAt
		}
	}
	a.mu.Lock()
	a.lastRiskTS = maxTS
	a.mu.Unlock()
}

func (a *Alerter) send(ctx context.Context, text string) {
	if err := a.slack.Post(ctx, text); err != nil {
		a.metrics.AlertsFailed.Add(1)
		slog.Error("slack post failed", "err", err)
		return
	}
	a.metrics.AlertsSent.Add(1)
}

// highestCrossed returns the largest alert percentage <= pct, or 0 if none are
// crossed. (e.g. pcts [50,80,100], pct 85 → 80.)
func highestCrossed(pcts []int, pct int) int {
	sorted := append([]int(nil), pcts...)
	sort.Ints(sorted)
	best := 0
	for _, p := range sorted {
		if pct >= p {
			best = p
		}
	}
	return best
}

func formatBudget(b Budget, spend float64, pct, crossed int) string {
	limit := "alert-only"
	if b.HardLimit {
		limit = "HARD LIMIT"
	}
	return fmt.Sprintf(
		":money_with_wings: *Budget %d%% threshold crossed* — %s `%s` is at *%d%%* ($%.2f / $%.2f, %s) [tenant %s]",
		crossed, b.ScopeType, b.ScopeID, pct, spend, b.AmountUSD, limit, b.TenantID)
}

func formatRisk(e RiskEvent) string {
	return fmt.Sprintf(
		":rotating_light: *Critical risk event* — %s on agent `%s` (severity %s): %s [tenant %s]",
		e.Category, e.AgentID, e.Severity, e.Detail, e.TenantID)
}
