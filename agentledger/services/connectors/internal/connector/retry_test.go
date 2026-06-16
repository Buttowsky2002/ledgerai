package connector

import (
	"context"
	"errors"
	"testing"
	"time"
)

func newTestRetrier(attempts int) (*Retrier, *int) {
	sleeps := 0
	r := NewRetrier(attempts, time.Millisecond, time.Second)
	r.sleep = func(context.Context, time.Duration) error { sleeps++; return nil }
	r.jitter = func(d time.Duration) time.Duration { return d } // deterministic
	return r, &sleeps
}

func TestRetrySucceedsAfterFailures(t *testing.T) {
	r, sleeps := newTestRetrier(3)
	calls := 0
	err := r.Do(context.Background(), func() error {
		calls++
		if calls < 3 {
			return errors.New("transient")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
	if *sleeps != 2 {
		t.Fatalf("sleeps = %d, want 2 (between the 3 attempts)", *sleeps)
	}
}

func TestRetryExhausts(t *testing.T) {
	r, _ := newTestRetrier(3)
	calls := 0
	want := errors.New("always")
	err := r.Do(context.Background(), func() error { calls++; return want })
	if !errors.Is(err, want) {
		t.Fatalf("err = %v, want %v", err, want)
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
}

func TestRetryStopsOnContextCancel(t *testing.T) {
	r := NewRetrier(5, time.Millisecond, time.Second)
	r.jitter = func(d time.Duration) time.Duration { return d }
	r.sleep = func(context.Context, time.Duration) error { return context.Canceled }
	calls := 0
	err := r.Do(context.Background(), func() error { calls++; return errors.New("fail") })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1 (cancel during first backoff)", calls)
	}
}

func TestRetryExponentialBackoff(t *testing.T) {
	var got []time.Duration
	r := NewRetrier(4, 10*time.Millisecond, time.Hour)
	r.jitter = func(d time.Duration) time.Duration { return d }
	r.sleep = func(_ context.Context, d time.Duration) error { got = append(got, d); return nil }
	_ = r.Do(context.Background(), func() error { return errors.New("fail") })
	want := []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 40 * time.Millisecond}
	if len(got) != len(want) {
		t.Fatalf("backoffs = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("backoff[%d] = %v, want %v", i, got[i], want[i])
		}
	}
}
