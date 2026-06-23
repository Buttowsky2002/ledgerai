package main

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

// newTestRedis starts a miniredis server scoped to t and returns a fail-open
// RedisBudgetStore connected to it (no drain function).
func newTestRedis(t *testing.T, keys []VirtualKey) (*miniredis.Miniredis, *RedisBudgetStore) {
	t.Helper()
	mr := miniredis.RunT(t)
	s, err := NewRedisBudgetStore(mr.Addr(), "", 0, keys, nil, false)
	if err != nil {
		t.Fatalf("NewRedisBudgetStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return mr, s
}

// reserveOK reserves est for vk and fails the test if the reservation is rejected.
func reserveOK(t *testing.T, s BudgetStore, vk *VirtualKey, est float64) *BudgetReservation {
	t.Helper()
	res, ok, reason := s.Reserve(vk, est)
	if !ok {
		t.Fatalf("Reserve rejected unexpectedly: %q", reason)
	}
	return res
}

// TestRedisBudgetEnforced verifies Commit accumulates spend and Reserve blocks
// once the monthly budget is reached.
func TestRedisBudgetEnforced(t *testing.T) {
	vk := VirtualKey{KeyID: "vk_budget", MonthlyBudget: 1.00}
	_, s := newTestRedis(t, []VirtualKey{vk})

	s.Commit(reserveOK(t, s, &vk, 0), 1.00) // book the full budget as realized cost

	_, ok, reason := s.Reserve(&vk, 0)
	if ok || reason != "monthly_budget_exceeded" {
		t.Fatalf("at budget: expected monthly_budget_exceeded, got ok=%v reason=%q", ok, reason)
	}
}

// TestRedisRateLimitEnforced verifies the sliding-window RPM gate via Reserve.
func TestRedisRateLimitEnforced(t *testing.T) {
	vk := VirtualKey{KeyID: "vk_rate", RateLimitRPM: 2}
	_, s := newTestRedis(t, []VirtualKey{vk})

	for i := 0; i < 2; i++ {
		if _, ok, reason := s.Reserve(&vk, 0); !ok {
			t.Fatalf("call %d (within limit): expected allowed, got reason=%q", i, reason)
		}
	}
	if _, ok, reason := s.Reserve(&vk, 0); ok || reason != "rate_limit_exceeded" {
		t.Fatalf("3rd call: expected rate_limit_exceeded, got ok=%v reason=%q", ok, reason)
	}
}

// TestRedisCommitAdjustsEstimateToActual verifies that a large hold committed to
// a small actual cost frees the difference so further requests are admitted.
func TestRedisCommitAdjustsEstimateToActual(t *testing.T) {
	vk := VirtualKey{KeyID: "vk_commit", MonthlyBudget: 1.00}
	_, s := newTestRedis(t, []VirtualKey{vk})

	// Hold 0.90, then commit only 0.10 actual.
	s.Commit(reserveOK(t, s, &vk, 0.90), 0.10)

	snap := s.Snapshot()
	got := snap["spend_usd_by_key"].(map[string]float64)["vk_commit"]
	if got < 0.099 || got > 0.101 {
		t.Fatalf("after commit, MTD spend = %v, want ~0.10", got)
	}
	// Plenty of budget remains, so a new reservation is admitted.
	if _, ok, reason := s.Reserve(&vk, 0); !ok {
		t.Fatalf("after commit-down expected admit, got reason=%q", reason)
	}
}

// TestRedisReleaseRestoresBudget verifies Release returns the full hold.
func TestRedisReleaseRestoresBudget(t *testing.T) {
	vk := VirtualKey{KeyID: "vk_release", MonthlyBudget: 1.00}
	_, s := newTestRedis(t, []VirtualKey{vk})

	s.Release(reserveOK(t, s, &vk, 0.90)) // hold then release the whole thing

	snap := s.Snapshot()
	got := snap["spend_usd_by_key"].(map[string]float64)["vk_release"]
	if got > 1e-9 {
		t.Fatalf("after release, MTD spend = %v, want 0", got)
	}
}

// TestRedisBudgetSurvivesRestart verifies committed spend persists in Redis
// across gateway restarts.
func TestRedisBudgetSurvivesRestart(t *testing.T) {
	vk := VirtualKey{KeyID: "vk_persist", MonthlyBudget: 5.00}
	mr := miniredis.RunT(t)

	s1, err := NewRedisBudgetStore(mr.Addr(), "", 0, []VirtualKey{vk}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	s1.Commit(reserveOK(t, s1, &vk, 0), 4.99)
	_ = s1.Close()

	s2, err := NewRedisBudgetStore(mr.Addr(), "", 0, []VirtualKey{vk}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s2.Close() }()

	s2.Commit(reserveOK(t, s2, &vk, 0), 0.02) // push over the limit

	if _, ok, reason := s2.Reserve(&vk, 0); ok || reason != "monthly_budget_exceeded" {
		t.Fatalf("after restart: expected budget exceeded, got ok=%v reason=%q", ok, reason)
	}
}

// TestRedisMonthKeyTTL verifies the budget key expiry is 7 days after month-end.
func TestRedisMonthKeyTTL(t *testing.T) {
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	got := monthKeyTTL(now)
	want := time.Date(2026, 7, 8, 0, 0, 0, 0, time.UTC).Sub(now)
	if got != want {
		t.Fatalf("monthKeyTTL = %v, want %v", got, want)
	}
}

// TestRedisDrainCallback verifies runDrain reports committed MTD spend per key.
func TestRedisDrainCallback(t *testing.T) {
	vk := VirtualKey{KeyID: "vk_drain", MonthlyBudget: 10.00}
	mr := miniredis.RunT(t)

	type drainCall struct {
		key, month string
		usd        float64
	}
	var calls []drainCall

	s, err := NewRedisBudgetStore(mr.Addr(), "", 0, []VirtualKey{vk}, func(key, month string, usd float64) {
		calls = append(calls, drainCall{key, month, usd})
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()

	s.Commit(reserveOK(t, s, &vk, 0), 3.50)
	s.runDrain()

	if len(calls) != 1 {
		t.Fatalf("drain calls = %d, want 1", len(calls))
	}
	if calls[0].key != vk.KeyID {
		t.Fatalf("drain key = %q, want %q", calls[0].key, vk.KeyID)
	}
	if calls[0].usd != 3.50 {
		t.Fatalf("drain usd = %v, want 3.50", calls[0].usd)
	}
}

// TestRedisRateLimitWindowResets verifies rate-limit slots expire after 60 s.
func TestRedisRateLimitWindowResets(t *testing.T) {
	vk := VirtualKey{KeyID: "vk_window", RateLimitRPM: 1}
	mr := miniredis.RunT(t)
	s, err := NewRedisBudgetStore(mr.Addr(), "", 0, []VirtualKey{vk}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()

	if _, ok, _ := s.Reserve(&vk, 0); !ok {
		t.Fatal("first call: expected allowed")
	}
	if _, ok, reason := s.Reserve(&vk, 0); ok || reason != "rate_limit_exceeded" {
		t.Fatalf("second call: expected rate_limit_exceeded, got ok=%v reason=%q", ok, reason)
	}

	mr.FastForward(71 * time.Second)

	if _, ok, reason := s.Reserve(&vk, 0); !ok {
		t.Fatalf("after window reset: expected allowed, got reason=%q", reason)
	}
}

// TestRedisReserveFailMode makes the configured fail mode explicit: with the
// backend unreachable, fail-open admits (a no-op reservation) and fail-closed
// rejects with budget_unavailable.
func TestRedisReserveFailMode(t *testing.T) {
	vk := VirtualKey{KeyID: "vk_failmode", MonthlyBudget: 1.00}

	t.Run("fail-open admits", func(t *testing.T) {
		mr := miniredis.RunT(t)
		s, err := NewRedisBudgetStore(mr.Addr(), "", 0, []VirtualKey{vk}, nil, false)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = s.Close() }()
		mr.Close() // backend now unreachable

		res, ok, reason := s.Reserve(&vk, 0.50)
		if !ok {
			t.Fatalf("fail-open should admit, got reason=%q", reason)
		}
		if res == nil || !res.noop {
			t.Fatalf("fail-open reservation should be a no-op, got %+v", res)
		}
		// Commit/Release on a no-op reservation must not panic or error.
		s.Commit(res, 0.50)
		s.Release(res)
	})

	t.Run("fail-closed rejects", func(t *testing.T) {
		mr := miniredis.RunT(t)
		s, err := NewRedisBudgetStore(mr.Addr(), "", 0, []VirtualKey{vk}, nil, true)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = s.Close() }()
		mr.Close()

		_, ok, reason := s.Reserve(&vk, 0.50)
		if ok || reason != "budget_unavailable" {
			t.Fatalf("fail-closed should reject, got ok=%v reason=%q", ok, reason)
		}
	})
}
