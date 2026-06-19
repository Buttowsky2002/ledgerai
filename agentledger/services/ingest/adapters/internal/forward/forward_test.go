package forward

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func fastClient(url string) *Client {
	return &Client{url: url, http: &http.Client{Timeout: 5 * time.Second}, maxRetries: 4, backoff: time.Millisecond}
}

func sampleEvents() []map[string]any {
	return []map[string]any{{"call_id": "litellm:1", "ts": "2026-06-19T12:00:00Z", "tenant_id": "t1"}}
}

func TestForwardSendsBatchAndSucceedsOn202(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	if err := fastClient(srv.URL).Send(context.Background(), sampleEvents()); err != nil {
		t.Fatalf("Send: %v", err)
	}
	// The body must be a JSON array (collector accepts arrays).
	var arr []map[string]any
	if err := json.Unmarshal(gotBody, &arr); err != nil || len(arr) != 1 {
		t.Fatalf("forwarded body = %s, want 1-element array", gotBody)
	}
}

func TestForwardRetriesOnBackpressure(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) < 3 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	if err := fastClient(srv.URL).Send(context.Background(), sampleEvents()); err != nil {
		t.Fatalf("Send should succeed after retries: %v", err)
	}
	if calls.Load() != 3 {
		t.Fatalf("calls = %d, want 3 (two 429s then 202)", calls.Load())
	}
}

func TestForwardDoesNotRetryOn422(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusUnprocessableEntity)
	}))
	defer srv.Close()

	err := fastClient(srv.URL).Send(context.Background(), sampleEvents())
	if err == nil {
		t.Fatal("expected error on 422")
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1 (422 is not retried)", calls.Load())
	}
}

func TestForwardEmptyIsNoop(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatal("empty batch must not hit the network")
	}))
	defer srv.Close()
	if err := fastClient(srv.URL).Send(context.Background(), nil); err != nil {
		t.Fatalf("empty Send: %v", err)
	}
}

func TestForwardFailsAfterMaxRetries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	if err := fastClient(srv.URL).Send(context.Background(), sampleEvents()); err == nil {
		t.Fatal("expected error after exhausting retries on persistent 429")
	}
}
