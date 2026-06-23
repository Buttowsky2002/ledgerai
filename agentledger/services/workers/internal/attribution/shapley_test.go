package attribution

import (
	"math"
	"testing"
)

func shareSum(c Coalition) float64 {
	s := 0.0
	for _, m := range c.Members {
		s += m.ShapleyValue
	}
	return s
}

func TestShapleyExactSumsToOne(t *testing.T) {
	members := []contributor{
		{agentID: "research", conf: 0.6},
		{agentID: "implement", conf: 0.9},
		{agentID: "review", conf: 0.7},
	}
	c := ShapleyAllocate(members, 1)
	if c.Method != "exact" || c.SampleCount != 0 {
		t.Fatalf("method = %s/%d, want exact/0", c.Method, c.SampleCount)
	}
	if !sigApprox(shareSum(c), 1.0) {
		t.Fatalf("shares sum = %v, want 1.0", shareSum(c))
	}
	// Allocations of a $900 outcome sum back to $900.
	var alloc float64
	for _, m := range c.Members {
		alloc += 900 * m.ShapleyValue
	}
	if !sigApprox(alloc, 900) {
		t.Fatalf("value allocation sum = %v, want 900", alloc)
	}
	// Higher individual confidence ⇒ higher share (monotone here).
	share := map[string]float64{}
	for _, m := range c.Members {
		share[m.AgentID] = m.ShapleyValue
	}
	if !(share["implement"] > share["review"] && share["review"] > share["research"]) {
		t.Fatalf("shares not ordered by contribution: %+v", share)
	}
}

func TestShapleyZeroContributor(t *testing.T) {
	// A coalition member that contributed nothing earns ≈ 0 (the adversarial case).
	members := []contributor{
		{agentID: "a", conf: 0.8},
		{agentID: "deadweight", conf: 0.0},
		{agentID: "b", conf: 0.7},
	}
	c := ShapleyAllocate(members, 1)
	for _, m := range c.Members {
		if m.AgentID == "deadweight" && m.ShapleyValue > 1e-9 {
			t.Fatalf("zero-contributor share = %v, want ~0", m.ShapleyValue)
		}
	}
	if !sigApprox(shareSum(c), 1.0) {
		t.Fatalf("shares sum = %v, want 1.0", shareSum(c))
	}
}

func TestShapleySymmetric(t *testing.T) {
	members := []contributor{{agentID: "a", conf: 0.5}, {agentID: "b", conf: 0.5}, {agentID: "c", conf: 0.5}}
	c := ShapleyAllocate(members, 1)
	for _, m := range c.Members {
		if !sigApprox(m.ShapleyValue, 1.0/3.0) {
			t.Fatalf("equal contributors: share %v, want 1/3", m.ShapleyValue)
		}
	}
}

func TestShapleyMonteCarlo(t *testing.T) {
	// 7 contributors → Monte-Carlo path. Deterministic for a fixed seed, shares sum
	// to ~1, and a confidence interval is reported.
	members := make([]contributor, 7)
	for i := range members {
		members[i] = contributor{agentID: string(rune('a' + i)), conf: 0.3 + 0.05*float64(i)}
	}
	a := ShapleyAllocate(members, 42)
	b := ShapleyAllocate(members, 42)
	if a.Method != "montecarlo" || a.SampleCount != shapleyMCSamples {
		t.Fatalf("method = %s/%d, want montecarlo/%d", a.Method, a.SampleCount, shapleyMCSamples)
	}
	for i := range a.Members {
		if a.Members[i].ShapleyValue != b.Members[i].ShapleyValue {
			t.Fatalf("Monte-Carlo not deterministic for fixed seed at %d", i)
		}
	}
	if math.Abs(shareSum(a)-1.0) > 1e-9 {
		t.Fatalf("MC shares sum = %v, want 1.0", shareSum(a))
	}
	anyCI := false
	for _, m := range a.Members {
		if m.CI > 0 {
			anyCI = true
		}
	}
	if !anyCI {
		t.Fatal("Monte-Carlo should report a confidence interval")
	}
}

func TestDeterministicCoalitionID(t *testing.T) {
	a := deterministicCoalitionID("t1", "github:acme/web#1")
	b := deterministicCoalitionID("t1", "github:acme/web#1")
	c := deterministicCoalitionID("t1", "github:acme/web#2")
	if a != b {
		t.Fatalf("coalition id not stable: %s vs %s", a, b)
	}
	if a == c {
		t.Fatal("different outcomes must yield different coalition ids")
	}
	if len(a) != 36 { // 8-4-4-4-12
		t.Fatalf("coalition id %q is not UUID-shaped", a)
	}
}
