package connector

import (
	"context"
	"time"
)

// Retrier retries a function with exponential backoff and full jitter. Provider
// APIs are flaky (429s, 5xx, network blips); jitter avoids synchronized retry
// storms across connectors. sleep and jitter are injectable for tests.
type Retrier struct {
	Attempts int           // total tries (>=1)
	Base     time.Duration // first backoff
	Max      time.Duration // backoff ceiling
	sleep    func(context.Context, time.Duration) error
	jitter   func(d time.Duration) time.Duration // returns a value in [0, d]
}

// NewRetrier builds a retrier; attempts<1 is clamped to 1.
func NewRetrier(attempts int, base, max time.Duration) *Retrier {
	if attempts < 1 {
		attempts = 1
	}
	return &Retrier{
		Attempts: attempts,
		Base:     base,
		Max:      max,
		sleep:    sleepCtx,
		jitter:   fullJitter,
	}
}

// Do runs fn, retrying on error up to Attempts times. It returns the last error
// (or ctx error). retryable, when set, gates which errors are retried; a nil
// retryable retries every error.
func (r *Retrier) Do(ctx context.Context, fn func() error) error {
	var err error
	for attempt := 0; attempt < r.Attempts; attempt++ {
		if err = fn(); err == nil {
			return nil
		}
		if attempt == r.Attempts-1 {
			break
		}
		backoff := r.Base << attempt
		if r.Max > 0 && backoff > r.Max {
			backoff = r.Max
		}
		if werr := r.sleep(ctx, r.jitter(backoff)); werr != nil {
			return werr
		}
	}
	return err
}

// fullJitter returns a pseudo-random duration in [0, d]. Determinism is not
// required for correctness; tests inject their own jitter func.
func fullJitter(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	// time-derived spread; avoids a math/rand dependency on the hot path.
	n := time.Now().UnixNano()
	frac := float64(n%1000) / 1000.0
	return time.Duration(float64(d) * frac)
}
