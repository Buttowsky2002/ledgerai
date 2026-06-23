package attribution

import (
	"math"
	"testing"
)

// base candidate: outcome at 10:00, run ended 10:00 (zero gap), same user, token
// in objective. Individual tests mutate one field to exercise present/absent/partial.
func baseSignalInput() SignalInput {
	return SignalInput{
		Outcome: OutcomeRow{
			OutcomeID:   "github:acme/web#42",
			TS:          "2026-06-10 10:00:00.000",
			OutcomeType: "pr_merged",
			UserID:      "alice",
		},
		Run: RunRow{
			RunID:     "r1",
			UserID:    "alice",
			EndedAt:   "2026-06-10 10:00:00.000",
			Objective: "fix acme/web#42",
		},
		Config: DefaultSignalConfig(),
	}
}

func sigApprox(a, b float64) bool { return math.Abs(a-b) <= 1e-9 }

func TestSignalTemporal(t *testing.T) {
	in := baseSignalInput()
	// Zero gap → 1.0.
	if r := signalTemporal(in); !sigApprox(r.Value, 1.0) {
		t.Fatalf("zero-gap temporal = %v, want 1.0", r.Value)
	}
	// One half-life later (pr_merged → 30m) → 0.5.
	in.Outcome.TS = "2026-06-10 10:30:00.000"
	if r := signalTemporal(in); !sigApprox(r.Value, 0.5) {
		t.Fatalf("one-halflife temporal = %v, want 0.5", r.Value)
	}
	// Slow type uses a longer half-life: 30m gap on ticket_resolved (120m) > 0.5.
	in.Outcome.OutcomeType = "ticket_resolved"
	r := signalTemporal(in)
	if r.Value <= 0.5 {
		t.Fatalf("slow-type temporal at 30m = %v, want > 0.5 (longer half-life)", r.Value)
	}
	// Outcome before the run ended → 0.
	in = baseSignalInput()
	in.Run.EndedAt = "2026-06-10 11:00:00.000"
	if r := signalTemporal(in); r.Value != 0 {
		t.Fatalf("negative-gap temporal = %v, want 0", r.Value)
	}
	// Unparseable timestamp → 0.
	in = baseSignalInput()
	in.Run.EndedAt = "not-a-time"
	if r := signalTemporal(in); r.Value != 0 {
		t.Fatalf("bad-time temporal = %v, want 0", r.Value)
	}
}

func TestSignalIdentity(t *testing.T) {
	in := baseSignalInput()
	if r := signalIdentity(in); r.Value != 1 || r.Evidence != "user:alice" {
		t.Fatalf("match identity = %+v, want 1/user:alice", r)
	}
	in.Run.UserID = "bob"
	if r := signalIdentity(in); r.Value != 0 {
		t.Fatalf("mismatch identity = %v, want 0", r.Value)
	}
	in.Run.UserID, in.Outcome.UserID = "", "" // both empty must NOT match
	if r := signalIdentity(in); r.Value != 0 {
		t.Fatalf("empty identity = %v, want 0", r.Value)
	}
}

func TestSignalContent(t *testing.T) {
	in := baseSignalInput()
	if r := signalContent(in); r.Value != 1 {
		t.Fatalf("token-in-objective content = %v, want 1", r.Value)
	}
	in.Run.Objective = "some other unrelated work"
	if r := signalContent(in); r.Value != 0 {
		t.Fatalf("no-token content = %v, want 0", r.Value)
	}
	in.Run.Objective = ""
	if r := signalContent(in); r.Value != 0 {
		t.Fatalf("empty-objective content = %v, want 0", r.Value)
	}
}

func TestSignalBehavioral(t *testing.T) {
	in := baseSignalInput() // zero gap, inside the 15m window
	if r := signalBehavioral(in); r.Value != 1 {
		t.Fatalf("in-window behavioral = %v, want 1", r.Value)
	}
	in.Outcome.TS = "2026-06-10 10:10:00.000" // 10m, still inside
	if r := signalBehavioral(in); r.Value != 1 {
		t.Fatalf("10m behavioral = %v, want 1", r.Value)
	}
	in.Outcome.TS = "2026-06-10 10:40:00.000" // 40m, outside
	if r := signalBehavioral(in); r.Value != 0 {
		t.Fatalf("40m behavioral = %v, want 0", r.Value)
	}
	in = baseSignalInput()
	in.Run.EndedAt = "2026-06-10 11:00:00.000" // outcome before run end
	if r := signalBehavioral(in); r.Value != 0 {
		t.Fatalf("negative-gap behavioral = %v, want 0", r.Value)
	}
}

func TestSignalArtifact(t *testing.T) {
	in := baseSignalInput()
	// Absent connector data → abstain (0).
	if r := signalArtifact(in); r.Value != 0 || r.Evidence != "no artifact data" {
		t.Fatalf("no-data artifact = %+v, want 0/no artifact data", r)
	}
	half := 0.5
	in.ArtifactOverlap = &half
	if r := signalArtifact(in); !sigApprox(r.Value, 0.5) {
		t.Fatalf("partial artifact = %v, want 0.5", r.Value)
	}
	over := 1.5 // out-of-range clamps to 1
	in.ArtifactOverlap = &over
	if r := signalArtifact(in); r.Value != 1 {
		t.Fatalf("over-range artifact = %v, want clamp 1", r.Value)
	}
}

func TestExtractSignalsRegistry(t *testing.T) {
	results := ExtractSignals(baseSignalInput())
	if len(results) != 5 {
		t.Fatalf("ExtractSignals returned %d signals, want 5", len(results))
	}
	want := []string{"temporal_proximity", "identity_match", "content_match", "behavioral_followup", "artifact_overlap"}
	for i, r := range results {
		if r.Name != want[i] {
			t.Fatalf("signal[%d] = %q, want %q (stable order)", i, r.Name, want[i])
		}
		if r.Type == "" {
			t.Fatalf("signal %q has empty type", r.Name)
		}
		if r.Value < 0 || r.Value > 1 {
			t.Fatalf("signal %q value %v out of [0,1]", r.Name, r.Value)
		}
	}
	// Determinism: same input → identical results.
	again := ExtractSignals(baseSignalInput())
	for i := range results {
		if results[i] != again[i] {
			t.Fatalf("non-deterministic signal %q: %+v vs %+v", results[i].Name, results[i], again[i])
		}
	}
}
