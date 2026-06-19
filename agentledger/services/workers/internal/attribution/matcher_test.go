package attribution

import (
	"context"
	"testing"
	"time"
)

type fakeCH struct {
	outcomes []OutcomeRow
	runs     []RunRow
	written  []OutcomeRow
}

func (f *fakeCH) FetchOutcomes(context.Context, string) ([]OutcomeRow, error) { return f.outcomes, nil }
func (f *fakeCH) FetchRuns(context.Context, string) ([]RunRow, error)         { return f.runs, nil }
func (f *fakeCH) WriteOutcomes(_ context.Context, rows []OutcomeRow) error {
	f.written = append(f.written, rows...)
	return nil
}

func TestMatcherRun(t *testing.T) {
	fake := &fakeCH{
		outcomes: []OutcomeRow{
			// identity + time + issue-token → high confidence
			{OutcomeID: "jira:PROJ-12", TenantID: "t1", TS: "2026-06-17 11:00:00.000", UserID: "acc-1"},
			// SDK direct link → 1.0
			{OutcomeID: "github:acme/web#42", TenantID: "t1", TS: "2026-06-17 10:00:00.000", UserID: "alice"},
			// time-only, no identity/token → low but above threshold
			{OutcomeID: "zendesk:99999", TenantID: "t1", TS: "2026-06-17 09:00:00.000", UserID: ""},
			// nearest run is >60min away with no other signal → below threshold, unattributed
			{OutcomeID: "jira:OLD-1", TenantID: "t1", TS: "2026-06-17 12:00:00.000", UserID: "nobody"},
			// already attributed identically → must NOT be re-written
			{OutcomeID: "manual:555", TenantID: "t1", TS: "2026-06-17 11:00:00.000", UserID: "z", RunID: "run-x5", AttributionConfidence: 1.0},
		},
		runs: []RunRow{
			{RunID: "run-jira", TenantID: "t1", UserID: "acc-1", EndedAt: "2026-06-17 10:50:00.000", Status: "completed", Objective: "work on PROJ-12 ticket"},
			{RunID: "run-direct", TenantID: "t1", UserID: "x", EndedAt: "2026-06-17 08:00:00.000", Status: "completed", OutcomeID: "github:acme/web#42"},
			{RunID: "run-zd", TenantID: "t1", UserID: "", EndedAt: "2026-06-17 08:55:00.000", Status: "completed", Objective: "handle support"},
			{RunID: "run-x5", TenantID: "t1", UserID: "z", EndedAt: "2026-06-17 10:30:00.000", Status: "completed", OutcomeID: "manual:555"},
		},
	}

	m := New(fake, 240*time.Minute, 30, 0.3, nil)
	m.now = func() time.Time { return time.Date(2026, 6, 17, 12, 0, 0, 0, time.UTC) }

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	got := map[string]OutcomeRow{}
	for _, w := range fake.written {
		got[w.OutcomeID] = w
	}

	// Three rows changed; OLD-1 (below threshold, was already 0/"") and manual:555
	// (unchanged) must not be re-written.
	if len(fake.written) != 3 {
		t.Fatalf("want 3 written rows, got %d: %+v", len(fake.written), fake.written)
	}
	if _, ok := got["jira:OLD-1"]; ok {
		t.Errorf("OLD-1 is below threshold and unchanged — must not be written")
	}
	if _, ok := got["manual:555"]; ok {
		t.Errorf("manual:555 attribution is unchanged — must not be re-written")
	}

	if r := got["jira:PROJ-12"]; r.RunID != "run-jira" || r.AttributionConfidence < 0.9 {
		t.Errorf("PROJ-12 = %q/%v, want run-jira / >0.9", r.RunID, r.AttributionConfidence)
	}
	if r := got["github:acme/web#42"]; r.RunID != "run-direct" || r.AttributionConfidence != 1.0 {
		t.Errorf("direct link = %q/%v, want run-direct / 1.0", r.RunID, r.AttributionConfidence)
	}
	if r := got["zendesk:99999"]; r.RunID != "run-zd" || r.AttributionConfidence < 0.3 || r.AttributionConfidence > 0.45 {
		t.Errorf("zendesk = %q/%v, want run-zd / time-only ~0.39", r.RunID, r.AttributionConfidence)
	}

	if fake == nil || m.metrics.Examined.Load() != 5 || m.metrics.Attributed.Load() != 4 || m.metrics.Updated.Load() != 3 {
		t.Errorf("metrics examined/attributed/updated = %d/%d/%d, want 5/4/3",
			m.metrics.Examined.Load(), m.metrics.Attributed.Load(), m.metrics.Updated.Load())
	}
}

func TestMatchNoCandidateIsUnattributed(t *testing.T) {
	m := New(&fakeCH{}, 240*time.Minute, 30, 0.3, nil)
	m.now = func() time.Time { return time.Date(2026, 6, 17, 12, 0, 0, 0, time.UTC) }
	// Run ended after the outcome → not a candidate.
	runID, conf := m.match(
		OutcomeRow{OutcomeID: "jira:X-1", TenantID: "t1", TS: "2026-06-17 09:00:00.000", UserID: "a"},
		[]RunRow{{RunID: "r", TenantID: "t1", UserID: "a", EndedAt: "2026-06-17 10:00:00.000", Status: "completed"}},
	)
	if runID != "" || conf != 0 {
		t.Fatalf("want unattributed, got %q/%v", runID, conf)
	}
}

func TestOutcomeKeyTokens(t *testing.T) {
	cases := map[string][]string{
		"jira:PROJ-123":      {"PROJ-123"},
		"github:acme/web#42": {"acme/web#42", "#42"},
		"zendesk:99999":      {"99999"},
		"zendesk:42":         nil, // too short to be distinctive
		"malformed":          nil,
	}
	for in, want := range cases {
		got := outcomeKeyTokens(in)
		if len(got) != len(want) {
			t.Errorf("%q → %v, want %v", in, got, want)
			continue
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("%q → %v, want %v", in, got, want)
				break
			}
		}
	}
}
