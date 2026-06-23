package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

// memSpend reads the month-to-date spend the snapshot reports for a KeyID.
// (Snapshot keys are already KeyIDs, which redactKey passes through unchanged.)
func memSpend(s BudgetStore, keyID string) float64 {
	m := s.Snapshot()["spend_usd_by_key"].(map[string]float64)
	return m[keyID]
}

func approx(a, b float64) bool { d := a - b; return d < 1e-9 && d > -1e-9 }

// TestMemConcurrentReservationsCannotExceedBudgetByMoreThanOne is the core
// concurrency-safety guarantee: many goroutines reserving against one key can
// overshoot the cap by at most a single reservation.
func TestMemConcurrentReservationsCannotExceedBudgetByMoreThanOne(t *testing.T) {
	const budget, est = 1.0, 0.3
	vk := VirtualKey{KeyID: "vk_conc", MonthlyBudget: budget}
	s := NewBudgetStore([]VirtualKey{vk})

	const N = 64
	var wg sync.WaitGroup
	var okCount int64
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, ok, _ := s.Reserve(&vk, est); ok {
				atomic.AddInt64(&okCount, 1)
			}
		}()
	}
	wg.Wait()

	got := int(okCount)
	held := memSpend(s, "vk_conc")

	// Overshoot is bounded by one reservation.
	if held >= budget+est {
		t.Fatalf("budget exceeded by more than one reservation: held=%v (budget=%v est=%v)", held, budget, est)
	}
	// Held equals exactly the admitted reservations.
	if !approx(held, float64(got)*est) {
		t.Fatalf("held %v != admitted %d * est %v", held, got, est)
	}
	// And we admitted right up to the cap (the second-to-last was still under it).
	if got < 1 || float64(got-1)*est >= budget {
		t.Fatalf("admitted count off: got=%d", got)
	}
}

// TestMemReleaseRestoresBudget verifies Release returns the whole hold.
func TestMemReleaseRestoresBudget(t *testing.T) {
	vk := VirtualKey{KeyID: "vk_rel", MonthlyBudget: 1.0}
	s := NewBudgetStore([]VirtualKey{vk})

	res := reserveOK(t, s, &vk, 0.9)
	if got := memSpend(s, "vk_rel"); !approx(got, 0.9) {
		t.Fatalf("after reserve, held=%v want 0.9", got)
	}
	s.Release(res)
	if got := memSpend(s, "vk_rel"); !approx(got, 0) {
		t.Fatalf("after release, held=%v want 0", got)
	}
	// Budget is free again.
	if _, ok, reason := s.Reserve(&vk, 0.9); !ok {
		t.Fatalf("after release expected admit, got reason=%q", reason)
	}
	// A second Release on the same reservation is a no-op (single-use guard).
	s.Release(res)
	if got := memSpend(s, "vk_rel"); !approx(got, 0.9) {
		t.Fatalf("double release should not change spend, held=%v", got)
	}
}

// TestMemCommitAdjustsEstimateToActual verifies Commit replaces the estimate
// with the realized cost.
func TestMemCommitAdjustsEstimateToActual(t *testing.T) {
	vk := VirtualKey{KeyID: "vk_com", MonthlyBudget: 10.0}
	s := NewBudgetStore([]VirtualKey{vk})

	res := reserveOK(t, s, &vk, 5.0)
	s.Commit(res, 2.0)
	if got := memSpend(s, "vk_com"); !approx(got, 2.0) {
		t.Fatalf("after commit, spend=%v want 2.0", got)
	}
	// Double commit is a no-op.
	s.Commit(res, 9.0)
	if got := memSpend(s, "vk_com"); !approx(got, 2.0) {
		t.Fatalf("double commit should not change spend, spend=%v", got)
	}
}

// TestMemBudgetExceeded verifies Reserve rejects once the cap is reached.
func TestMemBudgetExceeded(t *testing.T) {
	vk := VirtualKey{KeyID: "vk_b", MonthlyBudget: 1.0}
	s := NewBudgetStore([]VirtualKey{vk})

	s.Commit(reserveOK(t, s, &vk, 0), 1.0) // realize the full budget
	if _, ok, reason := s.Reserve(&vk, 0); ok || reason != "monthly_budget_exceeded" {
		t.Fatalf("expected monthly_budget_exceeded, got ok=%v reason=%q", ok, reason)
	}
}

// TestMemRateLimit verifies the per-minute gate still works through Reserve.
func TestMemRateLimit(t *testing.T) {
	vk := VirtualKey{KeyID: "vk_rl", RateLimitRPM: 2}
	s := NewBudgetStore([]VirtualKey{vk})

	reserveOK(t, s, &vk, 0)
	reserveOK(t, s, &vk, 0)
	if _, ok, reason := s.Reserve(&vk, 0); ok || reason != "rate_limit_exceeded" {
		t.Fatalf("3rd reserve: expected rate_limit_exceeded, got ok=%v reason=%q", ok, reason)
	}
}
