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
	stamped  []OutcomeRow
}

func (f *fakeV2CH) FetchOutcomes(context.Context, string) ([]OutcomeRow, error) {
	return f.outcomes, nil
}
func (f *fakeV2CH) FetchRuns(context.Context, string) ([]RunRow, error) { return f.runs, nil }
func (f *fakeV2CH) WriteOutcomes(_ context.Context, rows []OutcomeRow) error {
	f.stamped = append(f.stamped, rows...)
	return nil
}
func (f *fakeV2CH) FetchEvidence(context.Context, string) ([]EvidenceRow, error) {
	return f.evidence, nil
}
func (f *fakeV2CH) WriteAttributionEvents(_ context.Context, e []AttributionEvent) error {
	f.events = append(f.events, e...)
	return nil
}

// fakePG implements PGStore, recording what would be written.
type fakePG struct {
	ensured      []ModelVersion
	edges        map[string][]Edge
	baselines    map[string][]Baseline
	coalitions   map[string][]Coalition
	knownTenants map[string]bool // nil = all ids known (legacy tests)
}

func newFakePG() *fakePG {
	return &fakePG{edges: map[string][]Edge{}, baselines: map[string][]Baseline{}, coalitions: map[string][]Coalition{}}
}
func (p *fakePG) EnsureModelVersion(_ context.Context, mv ModelVersion) error {
	p.ensured = append(p.ensured, mv)
	return nil
}
func (p *fakePG) KnownTenants(_ context.Context, ids []string) (map[string]bool, error) {
	out := make(map[string]bool, len(ids))
	for _, id := range ids {
		if p.knownTenants == nil {
			out[id] = true
		} else if p.knownTenants[id] {
			out[id] = true
		}
	}
	return out, nil
}
func (p *fakePG) UpsertEdges(_ context.Context, tenant string, e []Edge) error {
	p.edges[tenant] = append(p.edges[tenant], e...)
	return nil
}
func (p *fakePG) UpsertBaselines(_ context.Context, tenant string, b []Baseline) error {
	p.baselines[tenant] = append(p.baselines[tenant], b...)
	return nil
}
func (p *fakePG) UpsertCoalitions(_ context.Context, tenant string, c []Coalition) error {
	p.coalitions[tenant] = append(p.coalitions[tenant], c...)
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

	if err := eng.Process(context.Background(), false); err != nil {
		t.Fatalf("process: %v", err)
	}

	// Both model lineages ensured before edges (deterministic + the active scorer).
	ensured := map[string]bool{}
	for _, mv := range pg.ensured {
		ensured[mv.Version] = true
	}
	if !ensured[ModelVersionDeterministic] || !ensured[DefaultScorerModel().Version] {
		t.Fatalf("ensured = %+v, want both deterministic + scorer versions", pg.ensured)
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

func TestEngineV2Coalition(t *testing.T) {
	// A research → implement → review chain: three agents, three runs, all
	// SDK-stamped to one ticket → a coalition whose value allocations sum to the
	// outcome value.
	ch := &fakeV2CH{
		outcomes: []OutcomeRow{
			{OutcomeID: "jira:PROJ-7", TenantID: "t1", TS: "2026-06-10 12:00:00.000",
				SourceSystem: "jira", OutcomeType: "ticket_resolved", UserID: "u1", BusinessValueUSD: 900},
		},
		runs: []RunRow{
			{RunID: "r1", TenantID: "t1", AgentID: "research", OutcomeID: "jira:PROJ-7", EndedAt: "2026-06-10 10:00:00.000", TotalCostUSD: 3},
			{RunID: "r2", TenantID: "t1", AgentID: "implement", OutcomeID: "jira:PROJ-7", EndedAt: "2026-06-10 11:00:00.000", TotalCostUSD: 9},
			{RunID: "r3", TenantID: "t1", AgentID: "review", OutcomeID: "jira:PROJ-7", EndedAt: "2026-06-10 11:45:00.000", TotalCostUSD: 2},
		},
	}
	pg := newFakePG()
	eng := NewEngineV2(ch, pg, 240*time.Minute, 30, nil)
	eng.now = func() time.Time { return time.Date(2026, 6, 12, 0, 0, 0, 0, time.UTC) }
	if err := eng.Process(context.Background(), false); err != nil {
		t.Fatalf("process: %v", err)
	}

	edges := pg.edges["t1"]
	if len(edges) != 3 {
		t.Fatalf("edges = %d, want 3 coalition members", len(edges))
	}
	var totalValue float64
	for _, e := range edges {
		if e.Method != "shapley" || e.CoalitionID == nil || e.ModelVersion != ModelVersionShapley {
			t.Fatalf("edge = %+v, want shapley + coalition_id + shapley model", e)
		}
		if e.ValueAttributed != nil {
			totalValue += *e.ValueAttributed
		}
	}
	// All three SDK-stamped (conf 1.0) ⇒ equal thirds; allocations sum to the value.
	if !sigApprox(totalValue, 900) {
		t.Fatalf("coalition value allocations sum = %v, want 900", totalValue)
	}
	// One coalition row persisted, three members, exact method.
	cols := pg.coalitions["t1"]
	if len(cols) != 1 || len(cols[0].Members) != 3 || cols[0].Method != "exact" {
		t.Fatalf("coalitions = %+v, want one exact coalition of 3 members", cols)
	}
	if cols[0].CoalitionID != deterministicCoalitionID("t1", "jira:PROJ-7") {
		t.Fatal("coalition id is not the deterministic id")
	}
}

func TestEngineV2ProcessProbabilistic(t *testing.T) {
	// No deterministic link (run carries no outcome_id, no evidence), but strong
	// signals: same user, close in time, token in objective → a probabilistic edge.
	ch := &fakeV2CH{
		outcomes: []OutcomeRow{
			{OutcomeID: "github:acme/web#7", TenantID: "t1", TS: "2026-06-10 10:00:00.000",
				SourceSystem: "github", OutcomeType: "pr_merged", UserID: "alice", BusinessValueUSD: 400},
		},
		runs: []RunRow{
			{RunID: "r1", TenantID: "t1", AgentID: "a1", UserID: "alice",
				EndedAt: "2026-06-10 09:50:00.000", Objective: "implement acme/web#7", TotalCostUSD: 6},
			// a weaker, earlier candidate by a different user
			{RunID: "r2", TenantID: "t1", AgentID: "a2", UserID: "bob",
				EndedAt: "2026-06-10 07:00:00.000", Objective: "unrelated", TotalCostUSD: 3},
		},
	}
	pg := newFakePG()
	eng := NewEngineV2(ch, pg, 240*time.Minute, 30, nil)
	eng.now = func() time.Time { return time.Date(2026, 6, 12, 0, 0, 0, 0, time.UTC) }
	if err := eng.Process(context.Background(), false); err != nil {
		t.Fatalf("process: %v", err)
	}

	edges := pg.edges["t1"]
	if len(edges) != 1 {
		t.Fatalf("edges = %d, want 1 probabilistic", len(edges))
	}
	e := edges[0]
	if e.Method != "probabilistic" || e.RunID != "r1" || e.AgentID != "a1" {
		t.Fatalf("edge = %+v, want probabilistic/r1/a1 (the stronger candidate)", e)
	}
	if e.ConfidenceCalibrated <= 0 || e.ConfidenceCalibrated > 1 {
		t.Fatalf("calibrated confidence %v out of (0,1]", e.ConfidenceCalibrated)
	}
	if e.ModelVersion != DefaultScorerModel().Version {
		t.Fatalf("model version = %s, want %s", e.ModelVersion, DefaultScorerModel().Version)
	}
	// signal_contributions present and well-formed (the explanation).
	var contribs []Contribution
	if err := json.Unmarshal(e.SignalContributions, &contribs); err != nil || len(contribs) != 5 {
		t.Fatalf("contributions = %s (err %v), want 5", e.SignalContributions, err)
	}
	if len(ch.events) != 1 || ch.events[0].Method != "probabilistic" {
		t.Fatalf("events = %+v, want one probabilistic", ch.events)
	}
}

func TestEngineV2SkipsUnknownTenants(t *testing.T) {
	ch := &fakeV2CH{
		outcomes: []OutcomeRow{
			{OutcomeID: "github:acme/web#1", TenantID: "known", SourceSystem: "github",
				OutcomeType: "pr_merged", BusinessValueUSD: 100},
			{OutcomeID: "jira:X-1", TenantID: "orphan", SourceSystem: "jira",
				OutcomeType: "ticket_resolved", BusinessValueUSD: 50},
		},
		runs: []RunRow{
			{RunID: "r1", TenantID: "known", AgentID: "a1", OutcomeID: "github:acme/web#1", TotalCostUSD: 5},
			{RunID: "r2", TenantID: "orphan", AgentID: "a2", TotalCostUSD: 3},
		},
		evidence: []EvidenceRow{
			{TenantID: "orphan", OutcomeID: "jira:X-1", EvidenceType: "co_authored_by", RunID: "r2"},
		},
	}
	pg := newFakePG()
	pg.knownTenants = map[string]bool{"known": true}
	eng := NewEngineV2(ch, pg, 240*time.Minute, 30, nil)
	eng.now = func() time.Time { return time.Date(2026, 6, 12, 0, 0, 0, 0, time.UTC) }
	if err := eng.Process(context.Background(), false); err != nil {
		t.Fatalf("process: %v", err)
	}
	if _, ok := pg.baselines["orphan"]; ok {
		t.Fatal("baselines written for orphan tenant")
	}
	if len(pg.edges["known"]) != 1 {
		t.Fatalf("known edges = %d, want 1", len(pg.edges["known"]))
	}
	if len(pg.edges["orphan"]) != 0 {
		t.Fatalf("orphan edges = %d, want 0", len(pg.edges["orphan"]))
	}
}

func TestEngineV2CutoverStampsOutcomes(t *testing.T) {
	ch := &fakeV2CH{
		outcomes: []OutcomeRow{
			{OutcomeID: "github:acme/web#42", TenantID: "t1", SourceSystem: "github",
				OutcomeType: "pr_merged", BusinessValueUSD: 500},
		},
		runs: []RunRow{
			{RunID: "r1", TenantID: "t1", AgentID: "a1", OutcomeID: "github:acme/web#42", TotalCostUSD: 8},
		},
	}
	pg := newFakePG()
	metrics := &V2Metrics{}
	eng := NewEngineV2(ch, pg, 240*time.Minute, 30, metrics)
	eng.now = func() time.Time { return time.Date(2026, 6, 12, 0, 0, 0, 0, time.UTC) }
	if err := eng.Process(context.Background(), true); err != nil {
		t.Fatalf("process: %v", err)
	}
	if len(ch.stamped) != 1 {
		t.Fatalf("stamped = %d, want 1", len(ch.stamped))
	}
	if ch.stamped[0].RunID != "r1" || ch.stamped[0].AttributionConfidence != ConfSDKStamp {
		t.Fatalf("stamped = %+v, want r1/conf 1.0", ch.stamped[0])
	}
	if metrics.Stamped.Load() != 1 {
		t.Fatalf("stamped metric = %d, want 1", metrics.Stamped.Load())
	}
}
