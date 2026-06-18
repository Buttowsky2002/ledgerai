package connector

import (
	"context"
	"testing"
	"time"
)

func TestRateLimiterSpacesCalls(t *testing.T) {
	base := time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC)
	nowT := base
	var slept []time.Duration

	rl := NewRateLimiter(100 * time.Millisecond)
	rl.now = func() time.Time { return nowT }
	rl.sleep = func(_ context.Context, d time.Duration) error { slept = append(slept, d); return nil }

	// First call: no prior reservation → no wait.
	_ = rl.Wait(context.Background())
	// Second call at the same instant → must wait one interval.
	_ = rl.Wait(context.Background())
	// Third call still at the same instant → must wait two intervals from now.
	_ = rl.Wait(context.Background())

	if len(slept) != 2 {
		t.Fatalf("expected 2 sleeps (calls 2 and 3), got %d: %v", len(slept), slept)
	}
	if slept[0] != 100*time.Millisecond || slept[1] != 200*time.Millisecond {
		t.Fatalf("sleeps = %v, want [100ms 200ms]", slept)
	}
}

func TestRateLimiterZeroIntervalIsNoop(t *testing.T) {
	rl := NewRateLimiter(0)
	called := false
	rl.sleep = func(context.Context, time.Duration) error { called = true; return nil }
	for i := 0; i < 5; i++ {
		_ = rl.Wait(context.Background())
	}
	if called {
		t.Fatal("zero-interval limiter must never sleep")
	}
}
