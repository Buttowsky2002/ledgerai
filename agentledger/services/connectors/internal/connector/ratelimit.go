package connector

import (
	"context"
	"sync"
	"time"
)

// RateLimiter enforces a minimum interval between calls (per connector), so an
// importer never exceeds a provider's request budget. It is an interval limiter
// rather than a bursty token bucket — provider usage APIs reward steady pacing.
//
// now/sleep are injectable so timing is deterministic in tests.
type RateLimiter struct {
	mu       sync.Mutex
	interval time.Duration
	next     time.Time
	now      func() time.Time
	sleep    func(context.Context, time.Duration) error
}

// NewRateLimiter builds a limiter allowing at most one call per interval.
// A non-positive interval yields a no-op limiter.
func NewRateLimiter(interval time.Duration) *RateLimiter {
	return &RateLimiter{
		interval: interval,
		now:      time.Now,
		sleep:    sleepCtx,
	}
}

// Wait blocks until the next call is permitted or ctx is cancelled.
func (r *RateLimiter) Wait(ctx context.Context) error {
	if r == nil || r.interval <= 0 {
		return nil
	}
	r.mu.Lock()
	now := r.now()
	wait := time.Duration(0)
	if now.Before(r.next) {
		wait = r.next.Sub(now)
	}
	// Reserve the next slot from the later of now / the previous reservation.
	base := now
	if r.next.After(now) {
		base = r.next
	}
	r.next = base.Add(r.interval)
	r.mu.Unlock()

	if wait <= 0 {
		return nil
	}
	return r.sleep(ctx, wait)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
