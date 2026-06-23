package attribution

import (
	"crypto/sha1" //nolint:gosec // G505: required for RFC-4122 UUIDv5 derivation below, not used as a security primitive
	"fmt"
	"hash/fnv"
	"math"
	"math/rand"
)

// Shapley multi-agent allocation (build-plan sub-phase 3.5) — the differentiator no
// competitor has. When several agents contribute to one outcome (a research →
// implement → review chain closing a ticket), credit must be split by MARGINAL
// contribution, not shared equally or won-takes-all.
//
// Characteristic function: v(S) = 1 − Π_{i∈S}(1 − c_i) — the noisy-OR combined
// attribution confidence of the runs in S, where c_i is run i's individual
// confidence to the outcome. v(∅)=0. An agent that adds no marginal confidence
// (redundant, or c_i=0) earns Shapley ≈ 0 — the adversarial case the build plan
// names. Shapley values are normalized to SHARES summing to 1, so the per-member
// value allocations sum to the outcome value (the §3.5 acceptance).
//
// Exact (subset enumeration) for n ≤ shapleyExactMax; seeded Monte Carlo
// permutation sampling with a reported confidence interval above it. The seed is
// derived from the outcome id so sampling is deterministic and reproducible
// (§3.5, §6) — stdlib math/rand, not the workflow RNG.

const (
	shapleyExactMax  = 5     // exact below this; Monte Carlo above
	shapleyMCSamples = 20000 // permutation samples for the MC path
)

// contributor is one agent's best contributing run to an outcome (the engine
// dedupes to one per agent before allocation).
type contributor struct {
	agentID  string
	runID    string
	conf     float64 // individual attribution confidence to the outcome
	method   string  // deterministic | probabilistic (how conf was derived)
	cost     float64 // the run's own AI cost
	contribs []byte  // signal_contributions JSON for this member's edge
}

// CoalitionMember is one agent's allocated share of an outcome.
type CoalitionMember struct {
	AgentID      string  `json:"agent_id"`
	RunID        string  `json:"run_id"`
	Confidence   float64 `json:"confidence"`    // individual c_i
	ShapleyValue float64 `json:"shapley_value"` // value share in [0,1]; Σ over members = 1
	CostUSD      float64 `json:"cost_usd"`      // the member's own run cost (cost is allocated by incurrence)
	CI           float64 `json:"ci,omitempty"`  // Monte-Carlo half-width (0 for exact)
	Order        int     `json:"order"`
}

// Coalition is the computed multi-agent allocation for one outcome.
type Coalition struct {
	CoalitionID string
	TenantID    string
	OutcomeID   string
	Members     []CoalitionMember
	Method      string // exact | montecarlo
	SampleCount int    // MC samples (0 for exact)
}

// ShapleyAllocate distributes an outcome's credit across the contributors by
// Shapley value over the noisy-OR characteristic function. Returns shares that sum
// to 1 (or equal shares if every contribution is zero).
func ShapleyAllocate(members []contributor, seed int64) Coalition {
	n := len(members)
	conf := make([]float64, n)
	for i, m := range members {
		conf[i] = m.conf
	}

	var phi, ci []float64
	method := "exact"
	sampleCount := 0
	if n <= shapleyExactMax {
		phi = shapleyExact(conf)
		ci = make([]float64, n) // exact → no sampling error
	} else {
		method = "montecarlo"
		sampleCount = shapleyMCSamples
		phi, ci = shapleyMonteCarlo(conf, sampleCount, seed)
	}

	sum := 0.0
	for _, p := range phi {
		sum += p
	}
	out := make([]CoalitionMember, n)
	for i, m := range members {
		share := 1.0 / float64(n)
		if sum > 0 {
			share = phi[i] / sum
		}
		out[i] = CoalitionMember{
			AgentID: m.agentID, RunID: m.runID, Confidence: m.conf,
			ShapleyValue: share, CostUSD: m.cost, CI: ci[i], Order: i,
		}
	}
	return Coalition{Members: out, Method: method, SampleCount: sampleCount}
}

// vChar is the noisy-OR characteristic value of a subset.
func vChar(conf []float64, subset []int) float64 {
	prod := 1.0
	for _, i := range subset {
		prod *= 1 - conf[i]
	}
	return 1 - prod
}

// shapleyExact computes exact Shapley values by enumerating every subset of the
// other players (n ≤ shapleyExactMax keeps 2^(n-1) tiny).
func shapleyExact(conf []float64) []float64 {
	n := len(conf)
	fact := make([]float64, n+1)
	fact[0] = 1
	for i := 1; i <= n; i++ {
		fact[i] = fact[i-1] * float64(i)
	}
	phi := make([]float64, n)
	for i := 0; i < n; i++ {
		others := make([]int, 0, n-1)
		for j := 0; j < n; j++ {
			if j != i {
				others = append(others, j)
			}
		}
		m := len(others)
		for mask := 0; mask < (1 << m); mask++ {
			subset := make([]int, 0, m)
			for b := 0; b < m; b++ {
				if mask&(1<<b) != 0 {
					subset = append(subset, others[b])
				}
			}
			s := len(subset)
			weight := fact[s] * fact[n-s-1] / fact[n]
			withI := vChar(conf, append(append([]int{}, subset...), i))
			phi[i] += weight * (withI - vChar(conf, subset))
		}
	}
	return phi
}

// shapleyMonteCarlo estimates Shapley values by averaging marginal contributions
// over random permutations (seeded → deterministic), returning the estimate and a
// 95% confidence half-width per player.
func shapleyMonteCarlo(conf []float64, samples int, seed int64) (phi, ci []float64) {
	n := len(conf)
	phi = make([]float64, n)
	sumSq := make([]float64, n)
	rng := rand.New(rand.NewSource(seed)) //nolint:gosec // G404: deterministic seeded RNG for reproducible Monte-Carlo sampling, not security-sensitive
	perm := make([]int, n)
	for i := range perm {
		perm[i] = i
	}
	for k := 0; k < samples; k++ {
		rng.Shuffle(n, func(a, b int) { perm[a], perm[b] = perm[b], perm[a] })
		prefix := make([]int, 0, n)
		base := 0.0
		for _, p := range perm {
			prefix = append(prefix, p)
			withP := vChar(conf, prefix)
			marg := withP - base
			phi[p] += marg
			sumSq[p] += marg * marg
			base = withP
		}
	}
	ci = make([]float64, n)
	for i := range phi {
		mean := phi[i] / float64(samples)
		variance := sumSq[i]/float64(samples) - mean*mean
		if variance < 0 {
			variance = 0
		}
		phi[i] = mean
		ci[i] = 1.96 * math.Sqrt(variance/float64(samples))
	}
	return phi, ci
}

// shapleySeed derives a deterministic per-outcome seed so Monte-Carlo sampling is
// reproducible (same outcome → same allocation).
func shapleySeed(tenantID, outcomeID string) int64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(tenantID + "\x00" + outcomeID))
	return int64(h.Sum64()) //nolint:gosec // G115: hash bits intentionally reinterpreted as a deterministic seed; wraparound is harmless
}

// deterministicCoalitionID maps (tenant, outcome) to a stable UUID so re-runs
// upsert the same coalition row (and edges' coalition_id always match the FK).
func deterministicCoalitionID(tenantID, outcomeID string) string {
	h := sha1.Sum([]byte("attribution-coalition\x00" + tenantID + "\x00" + outcomeID)) //nolint:gosec // G401: SHA-1 used for RFC-4122 UUIDv5 derivation, not as a security primitive
	var b [16]byte
	copy(b[:], h[:16])
	b[6] = (b[6] & 0x0f) | 0x50 // version 5
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
