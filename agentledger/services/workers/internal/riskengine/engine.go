package riskengine

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"
)

// Metrics holds risk-engine counters (atomic).
type Metrics struct {
	Runs         atomic.Int64 // passes executed
	AgentsRated  atomic.Int64 // agent_risk rows written
	EventsRaised atomic.Int64 // risk_events written
}

// Engine flags unauthorized tool usage as governed risk events and rolls each
// agent's exposure into agent_risk (→ risk-adjusted ROI via v_roi).
type Engine struct {
	ch       CHClient
	spikeMin uint32 // occurrences at/above which an unauthorized tool is "high" severity
	metrics  *Metrics
	now      func() time.Time
}

// New builds a risk Engine; spikeMin is the occurrence count at or above which an
// unauthorized tool is escalated to "high" severity (defaults to 5 when zero).
func New(ch CHClient, spikeMin uint32, m *Metrics) *Engine {
	if m == nil {
		m = &Metrics{}
	}
	if spikeMin == 0 {
		spikeMin = 5
	}
	return &Engine{ch: ch, spikeMin: spikeMin, metrics: m, now: time.Now}
}

// Run performs one risk pass: raise an event per unauthorized (agent, tool), and
// (re)write each agent's risk_exposure_pct. Both writes are idempotent via the
// ReplacingMergeTree keys, so a pass can safely re-run.
func (e *Engine) Run(ctx context.Context) error {
	e.metrics.Runs.Add(1)
	stamp := e.now().UTC().Format("2006-01-02 15:04:05.000")

	unauthorized, err := e.ch.UnauthorizedTools(ctx)
	if err != nil {
		return err
	}
	events := make([]RiskEvent, 0, len(unauthorized))
	for _, u := range unauthorized {
		events = append(events, RiskEvent{
			// Deterministic id → re-runs ReplacingMergeTree-collapse rather than duplicate.
			EventID:     "unauthorized_tool:" + u.AgentID + ":" + u.ToolName,
			TenantID:    u.TenantID,
			AgentID:     u.AgentID,
			Category:    "unauthorized_tool",
			Severity:    e.severity(u.Occurrences),
			Detail:      u.ToolName,
			Occurrences: u.Occurrences,
			FirstSeen:   u.FirstSeen,
			DetectedAt:  stamp,
		})
	}
	if err := e.ch.WriteRiskEvents(ctx, events); err != nil {
		return err
	}

	exposures, err := e.ch.AgentExposure(ctx)
	if err != nil {
		return err
	}
	risk := make([]AgentRisk, 0, len(exposures))
	for _, x := range exposures {
		risk = append(risk, AgentRisk{
			TenantID:        x.TenantID,
			AgentID:         x.AgentID,
			RiskExposurePct: x.ExposurePct,
			UpdatedAt:       stamp,
		})
	}
	if err := e.ch.WriteAgentRisk(ctx, risk); err != nil {
		return err
	}

	e.metrics.EventsRaised.Add(int64(len(events)))
	e.metrics.AgentsRated.Add(int64(len(risk)))
	slog.Info("risk pass complete", "events", len(events), "agents_rated", len(risk))
	return nil
}

// severity escalates with how often a disallowed tool was used: a single
// first-use is medium; repeated use (a spike) is high.
func (e *Engine) severity(occurrences uint32) string {
	if occurrences >= e.spikeMin {
		return "high"
	}
	return "medium"
}
