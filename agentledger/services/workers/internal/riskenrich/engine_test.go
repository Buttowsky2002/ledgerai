package riskenrich

import (
	"context"
	"errors"
	"testing"
)

type mockCH struct {
	behaviors []AgentBehavior
	written   []RiskEvent
	writeErr  error
}

func (m *mockCH) AgentBehaviors(_ context.Context, _, _ int) ([]AgentBehavior, error) {
	return m.behaviors, nil
}

func (m *mockCH) WriteRiskEvents(_ context.Context, events []RiskEvent) error {
	if m.writeErr != nil {
		return m.writeErr
	}
	m.written = append(m.written, events...)
	return nil
}

// mockClassifier returns a canned assessment per run_id; err if runErr matches.
type mockClassifier struct {
	byRun  map[string]Assessment
	errRun string
}

func (c *mockClassifier) Classify(_ context.Context, b AgentBehavior) (Assessment, error) {
	if b.RunID == c.errRun {
		return Assessment{}, errors.New("boom")
	}
	return c.byRun[b.RunID], nil
}

func TestEngineWritesConfidentFindings(t *testing.T) {
	ch := &mockCH{behaviors: []AgentBehavior{
		{TenantID: "t1", AgentID: "a1", RunID: "run_egress", Tools: []string{"read_file", "http_post"}, CallCount: 2},
		{TenantID: "t1", AgentID: "a2", RunID: "run_benign", Tools: []string{"search"}, CallCount: 1},
		{TenantID: "t1", AgentID: "a3", RunID: "run_lowconf", Tools: []string{"x", "y"}, CallCount: 2},
	}}
	cls := &mockClassifier{byRun: map[string]Assessment{
		"run_egress": {Findings: []Finding{
			{Category: "data_egress", Severity: "high", Confidence: 0.9, Rationale: "read then external send"},
		}},
		"run_benign": {Findings: []Finding{
			{Category: "none", Severity: "low", Confidence: 0.9, Rationale: "benign"},
		}},
		"run_lowconf": {Findings: []Finding{
			{Category: "anomalous_sequence", Severity: "medium", Confidence: 0.2, Rationale: "weak"},
		}},
	}}

	e := New(ch, cls, Config{MinConfidence: 0.5}, &Metrics{})
	if err := e.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}

	if len(ch.written) != 1 {
		t.Fatalf("wrote %d events, want 1 (egress only; benign + low-confidence dropped)", len(ch.written))
	}
	ev := ch.written[0]
	if ev.Category != "semantic_data_egress" {
		t.Errorf("category = %q, want semantic_data_egress", ev.Category)
	}
	if ev.Severity != "high" || ev.AgentID != "a1" || ev.RunID != "run_egress" {
		t.Errorf("unexpected event: %+v", ev)
	}
	if ev.EventID == "" || ev.EventID[:3] != "se_" {
		t.Errorf("event_id = %q, want se_ prefix", ev.EventID)
	}
}

func TestEngineEventIDDeterministic(t *testing.T) {
	a := semanticEventID("t1", "a1", "run1", "semantic_data_egress")
	b := semanticEventID("t1", "a1", "run1", "semantic_data_egress")
	c := semanticEventID("t1", "a1", "run1", "semantic_injection_suspected")
	if a != b {
		t.Errorf("same inputs must produce same id: %q != %q", a, b)
	}
	if a == c {
		t.Errorf("different category must produce different id")
	}
}

func TestEngineSkipsClassifierError(t *testing.T) {
	ch := &mockCH{behaviors: []AgentBehavior{
		{TenantID: "t1", AgentID: "a1", RunID: "run_err", Tools: []string{"x", "y"}, CallCount: 2},
		{TenantID: "t1", AgentID: "a2", RunID: "run_ok", Tools: []string{"x", "y"}, CallCount: 2},
	}}
	m := &Metrics{}
	cls := &mockClassifier{
		errRun: "run_err",
		byRun: map[string]Assessment{
			"run_ok": {Findings: []Finding{{Category: "injection_suspected", Severity: "high", Confidence: 0.8, Rationale: "ok"}}},
		},
	}
	e := New(ch, cls, Config{MinConfidence: 0.5}, m)
	if err := e.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(ch.written) != 1 {
		t.Fatalf("wrote %d events, want 1 (error run skipped)", len(ch.written))
	}
	if m.ClassifyErrors.Load() != 1 {
		t.Errorf("ClassifyErrors = %d, want 1", m.ClassifyErrors.Load())
	}
}

// TestEngineStampsPerTenantIsolation is the tenant-isolation guard for this
// cross-tenant background worker: identical agent/run metadata seen under two
// tenants must produce two separate, correctly-stamped events whose ids do not
// collide — a finding for tenant A can never be attributed to tenant B.
func TestEngineStampsPerTenantIsolation(t *testing.T) {
	ch := &mockCH{behaviors: []AgentBehavior{
		{TenantID: "tenant_a", AgentID: "a1", RunID: "shared_run", Tools: []string{"read_file", "http_post"}, CallCount: 2},
		{TenantID: "tenant_b", AgentID: "a1", RunID: "shared_run", Tools: []string{"read_file", "http_post"}, CallCount: 2},
	}}
	cls := &mockClassifier{byRun: map[string]Assessment{
		"shared_run": {Findings: []Finding{{Category: "data_egress", Severity: "high", Confidence: 0.9, Rationale: "read then external send"}}},
	}}
	e := New(ch, cls, Config{MinConfidence: 0.5}, &Metrics{})
	if err := e.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(ch.written) != 2 {
		t.Fatalf("wrote %d events, want 2 (one per tenant)", len(ch.written))
	}
	byTenant := map[string]RiskEvent{}
	for _, ev := range ch.written {
		byTenant[ev.TenantID] = ev
	}
	a, okA := byTenant["tenant_a"]
	b, okB := byTenant["tenant_b"]
	if !okA || !okB {
		t.Fatalf("each tenant must get its own stamped event: %+v", ch.written)
	}
	if a.EventID == b.EventID {
		t.Errorf("event_id must differ by tenant even for identical agent/run, got %q for both", a.EventID)
	}
}

func TestEngineNormalizesSeverity(t *testing.T) {
	for in, want := range map[string]string{"low": "low", "medium": "medium", "high": "high", "critical": "low", "": "low"} {
		if got := normalizeSeverity(in); got != want {
			t.Errorf("normalizeSeverity(%q) = %q, want %q", in, got, want)
		}
	}
}
