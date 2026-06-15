package main

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

// newTestRedis starts a miniredis server scoped to t and returns a
// RedisBudgetStore connected to it (with no drain function).
func newTestRedis(t *testing.T, keys []VirtualKey) (*miniredis.Miniredis, *RedisBudgetStore) {
	t.Helper()
	mr := miniredis.RunT(t)
	s, err := NewRedisBudgetStore(mr.Addr(), "", 0, keys, nil)
	if err != nil {
		t.Fatalf("NewRedisBudgetStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return mr, s
}

// TestRedisBudgetEnforced verifies that AddSpend increments the counter and
// CheckAndCount blocks once the monthly budget is reached.
func TestRedisBudgetEnforced(t *testing.T) {
	vk := VirtualKey{Key: "alk_budget", MonthlyBudget: 1.00}
	_, s := newTestRedis(t, []VirtualKey{vk})

	if ok, reason := s.CheckAndCount(&vk); !ok {
		t.Fatalf("below budget: expected allowed, got reason=%q", reason)
	}

	s.AddSpend(vk.Key, 1.00)

	ok, reason := s.CheckAndCount(&vk)
	if ok || reason != "monthly_budget_exceeded" {
		t.Fatalf("at budget: expected monthly_budget_exceeded, got ok=%v reason=%q", ok, reason)
	}
}

// TestRedisRateLimitEnforced verifies the sliding-window RPM gate.
func TestRedisRateLimitEnforced(t *testing.T) {
	vk := VirtualKey{Key: "alk_rate", RateLimitRPM: 2}
	_, s := newTestRedis(t, []VirtualKey{vk})

	for i := 0; i < 2; i++ {
		if ok, reason := s.CheckAndCount(&vk); !ok {
			t.Fatalf("call %d (within limit): expected allowed, got reason=%q", i, reason)
		}
	}

	ok, reason := s.CheckAndCount(&vk)
	if ok || reason != "rate_limit_exceeded" {
		t.Fatalf("3rd call: expected rate_limit_exceeded, got ok=%v reason=%q", ok, reason)
	}
}

// TestRedisBudgetSurvivesRestart verifies that AddSpend persists in Redis
// across gateway restarts: a new RedisBudgetStore on the same server sees
// the accumulated spend from the previous instance.
func TestRedisBudgetSurvivesRestart(t *testing.T) {
	vk := VirtualKey{Key: "alk_persist", MonthlyBudget: 5.00}
	mr := miniredis.RunT(t)

	// First "instance": record spend near the limit.
	s1, err := NewRedisBudgetStore(mr.Addr(), "", 0, []VirtualKey{vk}, nil)
	if err != nil {
		t.Fatal(err)
	}
	s1.AddSpend(vk.Key, 4.99)
	_ = s1.Close()

	// Second "instance" (gateway restart): must see the persisted spend.
	s2, err := NewRedisBudgetStore(mr.Addr(), "", 0, []VirtualKey{vk}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s2.Close() }()

	// Push it over the limit.
	s2.AddSpend(vk.Key, 0.02)

	ok, reason := s2.CheckAndCount(&vk)
	if ok || reason != "monthly_budget_exceeded" {
		t.Fatalf("after restart: expected budget exceeded, got ok=%v reason=%q", ok, reason)
	}
}

// TestRedisMonthKeyTTL verifies the budget key expiry is set to 7 days
// after the end of the month (retention for reconciliation).
func TestRedisMonthKeyTTL(t *testing.T) {
	// Mid-June 2026: next month starts 2026-07-01; +7d = 2026-07-08 00:00 UTC.
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	got := monthKeyTTL(now)
	want := time.Date(2026, 7, 8, 0, 0, 0, 0, time.UTC).Sub(now)
	if got != want {
		t.Fatalf("monthKeyTTL = %v, want %v", got, want)
	}
}

// TestRedisDrainCallback verifies that runDrain calls the drain function
// with the correct virtual key and MTD spend.
func TestRedisDrainCallback(t *testing.T) {
	vk := VirtualKey{Key: "alk_drain", MonthlyBudget: 10.00}
	mr := miniredis.RunT(t)

	type drainCall struct {
		key, month string
		usd        float64
	}
	var calls []drainCall

	s, err := NewRedisBudgetStore(mr.Addr(), "", 0, []VirtualKey{vk}, func(key, month string, usd float64) {
		calls = append(calls, drainCall{key, month, usd})
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()

	s.AddSpend(vk.Key, 3.50)
	s.runDrain()

	if len(calls) != 1 {
		t.Fatalf("drain calls = %d, want 1", len(calls))
	}
	if calls[0].key != vk.Key {
		t.Fatalf("drain key = %q, want %q", calls[0].key, vk.Key)
	}
	if calls[0].usd != 3.50 {
		t.Fatalf("drain usd = %v, want 3.50", calls[0].usd)
	}
}

// TestRedisRateLimitWindowResets verifies that rate-limit slots expire after
// the 60-second window by fast-forwarding miniredis time.
func TestRedisRateLimitWindowResets(t *testing.T) {
	vk := VirtualKey{Key: "alk_window", RateLimitRPM: 1}
	mr := miniredis.RunT(t)
	s, err := NewRedisBudgetStore(mr.Addr(), "", 0, []VirtualKey{vk}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()

	// First call: allowed.
	if ok, _ := s.CheckAndCount(&vk); !ok {
		t.Fatal("first call: expected allowed")
	}
	// Second call: rejected.
	if ok, reason := s.CheckAndCount(&vk); ok || reason != "rate_limit_exceeded" {
		t.Fatalf("second call: expected rate_limit_exceeded, got ok=%v reason=%q", ok, reason)
	}

	// Advance miniredis clock by 61 seconds to expire the rate key.
	mr.FastForward(61 * time.Second)

	// Third call: allowed again after window expired.
	if ok, reason := s.CheckAndCount(&vk); !ok {
		t.Fatalf("after window reset: expected allowed, got reason=%q", reason)
	}
}
