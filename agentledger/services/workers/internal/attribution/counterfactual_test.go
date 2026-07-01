package attribution

import (
	"context"
	"testing"
	"time"
)

func TestIncrementalDelta(t *testing.T) {
	// Half of a well-sampled subject's outcomes are unassisted → 50% incremental.
	d, c := incrementalDelta(5, 10)
	if !sigApprox(d, 0.5) || !c.Overlap || !c.Placebo {
		t.Fatalf("(5,10) → delta %v checks %+v, want 0.5 / overlap+placebo ok", d, c)
	}
	// A developer who ships mostly unassisted earns reduced incremental credit.
	if d, _ := incrementalDelta(8, 10); !sigApprox(d, 0.2) {
		t.Fatalf("(8,10) → delta %v, want 0.2 (high baseline ⇒ low credit)", d)
	}
	// No unassisted outcomes observed → delta 1 but placebo flagged (unobserved).
	d, c = incrementalDelta(0, 10)
	if !sigApprox(d, 1.0) || c.Placebo {
		t.Fatalf("(0,10) → delta %v placebo %v, want 1.0 / placebo false", d, c.Placebo)
	}
	if !hasCaveat(c, "baseline_unobserved") {
		t.Fatalf("(0,10) checks should flag baseline_unobserved: %+v", c)
	}
	// Tiny sample → overlap insufficient.
	if _, c := incrementalDelta(1, 2); c.Overlap {
		t.Fatalf("(1,2) overlap should be false (below min sample)")
	}
	// Empty.
	if d, c := incrementalDelta(0, 0); d != 1.0 || !hasCaveat(c, "no_outcomes") {
		t.Fatalf("(0,0) → %v / %+v, want 1.0 + no_outcomes", d, c)
	}
}

func TestComputeBaselinesAndDeltaFor(t *testing.T) {
	// alice: 10 pr_merged, 4 treated → baseline 6 → delta 0.4 (adequate sample).
	var outcomes []OutcomeRow
	treated := map[string]bool{}
	for i := 0; i < 10; i++ {
		id := "github:acme/web#" + itoa(i)
		o := OutcomeRow{OutcomeID: id, TenantID: "t1", UserID: "alice", TeamID: "core", OutcomeType: "pr_merged"}
		outcomes = append(outcomes, o)
		if i < 4 {
			treated["t1\x00"+id] = true
		}
	}
	bases := ComputeBaselines(outcomes, treated)

	idb := bases[baselineKey("t1", ScopeIdentity, "alice", "pr_merged")]
	if idb.BaselineCount != 6 || idb.TotalCount != 10 || !sigApprox(idb.Delta, 0.4) {
		t.Fatalf("identity baseline = %+v, want baseline 6 / total 10 / delta 0.4", idb)
	}
	// deltaFor picks the adequate identity baseline.
	if d, _, ok := deltaFor(bases, outcomes[0]); !ok || !sigApprox(d, 0.4) {
		t.Fatalf("deltaFor = %v ok=%v, want 0.4 / true", d, ok)
	}
	// Unknown subject → conservative full credit, flagged.
	d, c, ok := deltaFor(bases, OutcomeRow{TenantID: "t1", UserID: "stranger", OutcomeType: "pr_merged"})
	if ok || d != 1.0 || !hasCaveat(c, "no_baseline") {
		t.Fatalf("unknown subject → %v ok=%v %+v, want 1.0 / false / no_baseline", d, ok, c)
	}
}

// TestEngineV2Counterfactual is the §3.4 acceptance: a developer who already ships
// a lot unassisted shows REDUCED incremental attribution. alice has 5 pr_merged
// outcomes; only 2 are agent-attributed (the other 3 have no candidate run in
// window) → baseline 3/5 → delta 0.4 → the treated edges carry 40% of gross value.
func TestEngineV2Counterfactual(t *testing.T) {
	mk := func(id string, ts string, val float64) OutcomeRow {
		return OutcomeRow{OutcomeID: id, TenantID: "t1", TS: ts, SourceSystem: "github",
			OutcomeType: "pr_merged", UserID: "alice", TeamID: "core", BusinessValueUSD: val}
	}
	ch := &fakeV2CH{
		outcomes: []OutcomeRow{
			mk("github:acme/web#1", "2026-06-10 09:10:00.000", 100), // treated by r1
			mk("github:acme/web#2", "2026-06-10 09:20:00.000", 100), // treated by r2
			// three unassisted outcomes hours later — no run within the window.
			mk("github:acme/web#3", "2026-06-10 18:00:00.000", 100),
			mk("github:acme/web#4", "2026-06-10 18:30:00.000", 100),
			mk("github:acme/web#5", "2026-06-10 19:00:00.000", 100),
		},
		runs: []RunRow{
			{RunID: "r1", TenantID: "t1", AgentID: "a1", UserID: "alice", EndedAt: "2026-06-10 09:05:00.000", Objective: "work", TotalCostUSD: 5},
			{RunID: "r2", TenantID: "t1", AgentID: "a1", UserID: "alice", EndedAt: "2026-06-10 09:15:00.000", Objective: "work", TotalCostUSD: 5},
		},
	}
	pg := newFakePG()
	eng := NewEngineV2(ch, pg, 240*time.Minute, 30, nil)
	eng.now = func() time.Time { return time.Date(2026, 6, 12, 0, 0, 0, 0, time.UTC) }
	if err := eng.Process(context.Background(), false); err != nil {
		t.Fatalf("process: %v", err)
	}

	edges := pg.edges["t1"]
	if len(edges) != 2 {
		t.Fatalf("edges = %d, want 2 treated (the other 3 are unassisted)", len(edges))
	}
	for _, e := range edges {
		if e.CounterfactualDelta == nil || !sigApprox(*e.CounterfactualDelta, 0.4) {
			t.Fatalf("edge %s counterfactual_delta = %v, want 0.4", e.OutcomeID, e.CounterfactualDelta)
		}
		// value_attributed is the INCREMENTAL share: 100 × 0.4 = 40.
		if e.ValueAttributed == nil || !sigApprox(*e.ValueAttributed, 40) {
			t.Fatalf("edge %s value_attributed = %v, want 40 (gross 100 × delta 0.4)", e.OutcomeID, e.ValueAttributed)
		}
	}
	// The identity baseline was persisted with its sample + checks.
	var found bool
	for _, b := range pg.baselines["t1"] {
		if b.Scope == ScopeIdentity && b.SubjectID == "alice" {
			found = true
			if b.TotalCount != 5 || b.BaselineCount != 3 {
				t.Fatalf("persisted baseline = %+v, want total 5 / baseline 3", b)
			}
		}
	}
	if !found {
		t.Fatal("identity baseline for alice was not persisted")
	}
}

func hasCaveat(c ConfounderChecks, want string) bool {
	for _, cv := range c.Caveats {
		if cv == want {
			return true
		}
	}
	return false
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
