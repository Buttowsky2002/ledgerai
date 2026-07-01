package pricesync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestFetchUsesTimeoutClient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"gpt-4o":{"input_cost_per_token":2.5e-06,"litellm_provider":"openai"}}`))
	}))
	defer srv.Close()

	m := &Metrics{}
	f := NewFetcher(srv.URL, 5*time.Second, m)
	if f.HTTPClient() == http.DefaultClient {
		t.Fatal("fetch must not use http.DefaultClient")
	}
	if f.HTTPClient().Timeout != 5*time.Second {
		t.Fatalf("timeout = %v, want 5s", f.HTTPClient().Timeout)
	}

	got, err := f.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got["gpt-4o"]; !ok {
		t.Fatal("expected gpt-4o entry")
	}
}

func TestFetchNon200IncrementsFetchErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	m := &Metrics{}
	f := NewFetcher(srv.URL, 2*time.Second, m)
	if _, err := f.Fetch(context.Background()); err == nil {
		t.Fatal("expected error")
	}
	if m.FetchErrors.Load() != 1 {
		t.Fatalf("fetch_errors = %d, want 1", m.FetchErrors.Load())
	}
}

func TestFetchSkipsSampleSpecAndMissingInputRate(t *testing.T) {
	body, err := os.ReadFile("testdata/feed.json")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	f := NewFetcher(srv.URL, 2*time.Second, &Metrics{})
	got, err := f.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got["sample_spec"]; ok {
		t.Fatal("sample_spec must be skipped")
	}
	if _, ok := got["no-input-rate"]; ok {
		t.Fatal("entries without input_cost_per_token must be skipped")
	}
	if _, ok := got["gpt-4o"]; !ok {
		t.Fatal("expected tracked feed entry")
	}
}

func loadTestFeedFromPath(path string) (map[string]FeedModelEntry, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	out := make(map[string]FeedModelEntry)
	for id, msg := range raw {
		if id == "sample_spec" {
			continue
		}
		var probe struct {
			InputCostPerToken *float64 `json:"input_cost_per_token"`
		}
		if err := json.Unmarshal(msg, &probe); err != nil || probe.InputCostPerToken == nil {
			continue
		}
		var entry FeedModelEntry
		if err := json.Unmarshal(msg, &entry); err != nil {
			continue
		}
		out[id] = entry
	}
	return out, nil
}
