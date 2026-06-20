package riskengine

import (
	"context"
	"errors"
	"testing"
	"time"
)

type mockCH struct {
	unauth   []UnauthorizedTool
	exposure []AgentExposure
	queryErr error
	writeErr error
	events   []RiskEvent
	risk     []AgentRisk
}

func (m *mockCH) UnauthorizedTools(context.Context) ([]UnauthorizedTool, error) {
	return m.unauth, m.queryErr
}
func (m *mockCH) AgentExposure(context.Context) ([]AgentExposure, error) {
	return m.exposure, m.queryErr
}
func (m *mockCH) WriteRiskEvents(_ context.Context, e []RiskEvent) error {
	if m.writeErr != nil {
		return m.writeErr
	}
	m.events = append(m.events, e...)
	return nil
}
func (m *mockCH) WriteAgentRisk(_ context.Context, r []AgentRisk) error {
	if m.writeErr != nil {
		return m.writeErr
	}
	m.risk = append(m.risk, r...)
	return nil
}

func fixedNow() func() time.Time {
	return func() time.Time { return time.Date(2026, 6, 16, 9, 0, 0, 0, time.UTC) }
}

func TestEngineRaisesEventsAndRatesAgents(t *testing.T) {
	ch := &mockCH{
		unauth: []UnauthorizedTool{
			{TenantID: "t1", AgentID: "A1", ToolName: "shell_exec", FirstSeen: "2026-06-10 10:00:00.000", Occurrences: 2},
			{TenantID: "t1", AgentID: "A2", ToolName: "http_fetch", FirstSeen: "2026-06-10 10:00:00.000", Occurrences: 7},
		},
		exposure: []AgentExposure{
			{TenantID: "t1", AgentID: "A1", TotalCalls: 3, UnauthorizedCalls: 2, ExposurePct: 0.6667},
			{TenantID: "t1", AgentID: "A2", TotalCalls: 7, UnauthorizedCalls: 7, ExposurePct: 1.0},
		},
	}
	m := &Metrics{}
	e := New(ch, 5, m)
	e.now = fixedNow()
	if err := e.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(ch.events) != 2 {
		t.Fatalf("events = %d, want 2", len(ch.events))
	}
	bySeverity := map[string]string{}
	for _, ev := range ch.events {
		bySeverity[ev.AgentID] = ev.Severity
		if ev.Category != "unauthorized_tool" || ev.DetectedAt == "" {
			t.Errorf("bad event: %+v", ev)
		}
	}
	// 2 occurrences (< spikeMin 5) → medium; 7 occurrences → high.
	if bySeverity["A1"] != "medium" || bySeverity["A2"] != "high" {
		t.Fatalf("severity = %v, want A1 medium / A2 high", bySeverity)
	}
	// Deterministic event id (idempotent re-runs).
	if ch.events[0].EventID != "unauthorized_tool:A1:shell_exec" {
		t.Fatalf("event_id = %q", ch.events[0].EventID)
	}

	if len(ch.risk) != 2 {
		t.Fatalf("agent_risk rows = %d, want 2", len(ch.risk))
	}
	for _, r := range ch.risk {
		if r.AgentID == "A2" && r.RiskExposurePct != 1.0 {
			t.Errorf("A2 exposure = %v, want 1.0", r.RiskExposurePct)
		}
	}
	if m.EventsRaised.Load() != 2 || m.AgentsRated.Load() != 2 {
		t.Fatalf("metrics events=%d agents=%d", m.EventsRaised.Load(), m.AgentsRated.Load())
	}
}

func TestEngineNoUnauthorizedIsClean(t *testing.T) {
	ch := &mockCH{exposure: []AgentExposure{{TenantID: "t1", AgentID: "A1", TotalCalls: 5, UnauthorizedCalls: 0, ExposurePct: 0}}}
	e := New(ch, 5, nil)
	e.now = fixedNow()
	if err := e.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(ch.events) != 0 {
		t.Fatalf("events = %d, want 0", len(ch.events))
	}
	if len(ch.risk) != 1 || ch.risk[0].RiskExposurePct != 0 {
		t.Fatalf("agent_risk = %+v, want one row at 0", ch.risk)
	}
}

func TestEngineQueryError(t *testing.T) {
	e := New(&mockCH{queryErr: errors.New("ch down")}, 5, nil)
	e.now = fixedNow()
	if err := e.Run(context.Background()); err == nil {
		t.Fatal("expected error when query fails")
	}
}
