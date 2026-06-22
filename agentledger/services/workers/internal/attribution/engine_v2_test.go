package attribution

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// fakeV2CH implements CHReaderV2 over in-memory slices.
type fakeV2CH struct {
	outcomes []OutcomeRow
	runs     []RunRow
	evidence []EvidenceRow
	events   []AttributionEvent
}

func (f *fakeV2CH) FetchOutcomes(context.Context, string) ([]OutcomeRow, error) {
	return f.outcomes, nil
}
func (f *fakeV2CH) FetchRuns(context.Context, string) ([]RunRow, error) { return f.runs, nil }
func (f *fakeV2CH) WriteOutcomes(context.Context, []OutcomeRow) error   { return nil }
func (f *fakeV2CH) FetchEvidence(context.Context, string) ([]EvidenceRow, error) {
	return f.evidence, nil
}
func (f *fakeV2CH) WriteAttributionEvents(_ context.Context, e []AttributionEvent) error {
	f.events = append(f.events, e...)
	return nil
}

// fakePG implements PGStore, recording what would be written.
type fakePG struct {
	ensured []ModelVersion
	edges   map[string][]Edge
}

func newFakePG() *fakePG { return &fakePG{edges: map[string][]Edge{}} }
func (p *fakePG) EnsureModelVersion(_ context.Context, mv ModelVersion) error {
	p.ensured = append(p.ensured, mv)
	return nil
}
func (p *fakePG) UpsertEdges(_ context.Context, tenant string, e []Edge) error {
	p.edges[tenant] = append(p.edges[tenant], e...)
	return nil
}
func (p *fakePG) Ping(context.Context) error { return nil }
func (p *fakePG) Close() error               { return nil }

func TestEngineV2ProcessDeterministic(t *testing.T) {
	ch := &fakeV2CH{
		outcomes: []OutcomeRow{
			// SDK-stamped PR → deterministic 1.0
			{OutcomeID: "github:acme/web#42", TenantID: "t1", SourceSystem: "github",
				OutcomeType: "pr_merged", BusinessValueUSD: 500},
			// evidence-linked ticket → deterministic 0.97
			{OutcomeID: "jira:PROJ-9", TenantID: "t1", SourceSystem: "jira",
				OutcomeType: "ticket_resolved", BusinessValueUSD: 300},
			// no link → skipped (falls through to probabilistic stages later)
			{OutcomeID: "zendesk:1", TenantID: "t1", SourceSystem: "zendesk", BusinessValueUSD: 100},
		},
		runs: []RunRow{
			{RunID: "r1", TenantID: "t1", AgentID: "a1", OutcomeID: "github:acme/web#42", TotalCostUSD: 8},
			{RunID: "r2", TenantID: "t1", AgentID: "a2", TotalCostUSD: 4},
		},
		evidence: []EvidenceRow{
			{TenantID: "t1", OutcomeID: "jira:PROJ-9", EvidenceType: "co_authored_by", RunID: "r2"},
		},
	}
	pg := newFakePG()
	eng := NewEngineV2(ch, pg, 240*time.Minute, 30, nil)
	eng.now = func() time.Time { return time.Date(2026, 6, 12, 0, 0, 0, 0, time.UTC) }

	if err := eng.Process(context.Background()); err != nil {
		t.Fatalf("process: %v", err)
	}

	// Model lineage ensured before edges.
	if len(pg.ensured) != 1 || pg.ensured[0].Version != ModelVersionDeterministic {
		t.Fatalf("ensured = %+v, want one deterministic model version", pg.ensured)
	}

	edges := pg.edges["t1"]
	if len(edges) != 2 {
		t.Fatalf("edges = %d, want 2 deterministic (SDK + evidence)", len(edges))
	}
	byOutcome := map[string]Edge{}
	for _, e := range edges {
		byOutcome[e.OutcomeID] = e
	}
	pr := byOutcome["github:acme/web#42"]
	if pr.Method != "deterministic" || pr.ConfidenceCalibrated != ConfSDKStamp ||
		pr.RunID != "r1" || pr.AgentID != "a1" || pr.CostAttributed == nil || *pr.CostAttributed != 8 {
		t.Fatalf("PR edge = %+v, want deterministic/1.0/r1/a1/cost 8", pr)
	}
	if pr.ValueAttributed == nil || *pr.ValueAttributed != 500 {
		t.Fatalf("PR edge value = %v, want gross 500", pr.ValueAttributed)
	}
	// signal_contributions carries the evidence ref (the audit trail).
	var sc []signalContribution
	if err := json.Unmarshal(pr.SignalContributions, &sc); err != nil || len(sc) != 1 ||
		sc[0].EvidenceRef != "https://github.com/acme/web/pull/42" {
		t.Fatalf("PR signal_contributions = %s (err %v), want one entry with PR URL", pr.SignalContributions, err)
	}
	ticket := byOutcome["jira:PROJ-9"]
	if ticket.ConfidenceCalibrated != ConfHardEvidence || ticket.RunID != "r2" || ticket.AgentID != "a2" {
		t.Fatalf("ticket edge = %+v, want 0.97/r2/a2", ticket)
	}

	// One attribution_event per edge, tagged engine_version=v2.
	if len(ch.events) != 2 {
		t.Fatalf("events = %d, want 2", len(ch.events))
	}
	for _, e := range ch.events {
		if e.EngineVersion != "v2" || e.Method != "deterministic" {
			t.Fatalf("event = %+v, want v2/deterministic", e)
		}
	}
}
