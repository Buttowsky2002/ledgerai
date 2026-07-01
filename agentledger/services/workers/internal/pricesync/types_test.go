package pricesync

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestPriceEntryRoundTripLivePriceBook(t *testing.T) {
	path := repoPriceBookPath(t)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read live price book: %v", err)
	}

	var entries []PriceEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("unmarshal live price book: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("live price book is empty")
	}

	out, err := MarshalPriceBook(entries)
	if err != nil {
		t.Fatalf("marshal price book: %v", err)
	}

	var round []PriceEntry
	if err := json.Unmarshal(out, &round); err != nil {
		t.Fatalf("re-unmarshal candidate: %v", err)
	}

	if len(round) != len(entries) {
		t.Fatalf("entry count = %d, want %d", len(round), len(entries))
	}

	liveSet := indexByRow(entries)
	for _, e := range round {
		key := rowKey(e.Provider, e.Model, e.TokenType)
		prev, ok := liveSet[key]
		if !ok {
			t.Fatalf("unexpected row after round-trip: %+v", e)
		}
		if !ratesEqual(prev.USDPerMillion, e.USDPerMillion) {
			t.Fatalf("usd_per_million drift for %s: got %v want %v", key, e.USDPerMillion, prev.USDPerMillion)
		}
		if !prev.EffectiveStart.Equal(e.EffectiveStart) {
			t.Fatalf("effective_start drift for %s", key)
		}
		if prev.Source != e.Source {
			t.Fatalf("source drift for %s", key)
		}
	}
}

func TestCandidateMatchesGatewayLoadShape(t *testing.T) {
	path := repoPriceBookPath(t)
	live, err := LoadPriceBook(path)
	if err != nil {
		t.Fatal(err)
	}

	feed, err := loadTestFeed(t)
	if err != nil {
		t.Fatal(err)
	}
	runAt := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	candidate := Normalize(feed, live, runAt, "https://example.test/feed.json")

	out, err := MarshalPriceBook(candidate)
	if err != nil {
		t.Fatal(err)
	}
	var parsed []PriceEntry
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("candidate must deserialize as flat PriceEntry array: %v", err)
	}
	if len(parsed) != len(candidate) {
		t.Fatalf("parsed len = %d, want %d", len(parsed), len(candidate))
	}
}

func repoPriceBookPath(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "pricing", "pricebook.json"))
}

func indexByRow(entries []PriceEntry) map[string]PriceEntry {
	m := make(map[string]PriceEntry, len(entries))
	for _, e := range entries {
		m[rowKey(e.Provider, e.Model, e.TokenType)] = e
	}
	return m
}

func loadTestFeed(t *testing.T) (map[string]FeedModelEntry, error) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "feed.json"))
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
