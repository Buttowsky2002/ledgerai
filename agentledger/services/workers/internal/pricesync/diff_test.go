package pricesync

import (
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"
)

func TestDiffGolden(t *testing.T) {
	live, err := LoadPriceBook("testdata/live_pricebook.json")
	if err != nil {
		t.Fatal(err)
	}
	feed, err := loadTestFeedFromPath("testdata/feed.json")
	if err != nil {
		t.Fatal(err)
	}
	runAt := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	candidate := Normalize(feed, live, runAt, "https://example.test/feed.json")
	got := Diff(live, candidate, "https://example.test/feed.json", runAt)

	wantRaw, err := os.ReadFile("testdata/diff_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var want DiffReport
	if err := json.Unmarshal(wantRaw, &want); err != nil {
		t.Fatal(err)
	}

	if got.Unchanged != want.Unchanged {
		t.Fatalf("unchanged = %d, want %d", got.Unchanged, want.Unchanged)
	}
	if len(got.Changes) != len(want.Changes) {
		t.Fatalf("changes = %d, want %d", len(got.Changes), len(want.Changes))
	}

	wantByKey := make(map[string]Change, len(want.Changes))
	for _, c := range want.Changes {
		wantByKey[rowKey(c.Provider, c.Model, c.TokenType)] = c
	}
	for _, c := range got.Changes {
		w, ok := wantByKey[rowKey(c.Provider, c.Model, c.TokenType)]
		if !ok {
			t.Fatalf("unexpected change: %+v", c)
		}
		if c.Kind != w.Kind {
			t.Fatalf("kind = %q, want %q", c.Kind, w.Kind)
		}
		if c.NewUSDPerMillion != w.NewUSDPerMillion {
			t.Fatalf("new_usd_per_million = %v, want %v", c.NewUSDPerMillion, w.NewUSDPerMillion)
		}
		if w.OldUSDPerMillion != nil {
			if c.OldUSDPerMillion == nil || *c.OldUSDPerMillion != *w.OldUSDPerMillion {
				t.Fatalf("old_usd_per_million mismatch for %+v", c)
			}
		}
		if w.PctChange != nil {
			if c.PctChange == nil || math.Abs(*c.PctChange-*w.PctChange) > 1e-9 {
				t.Fatalf("pct_change = %v, want %v", c.PctChange, w.PctChange)
			}
		}
	}
}

func TestDiffRemovedTrackedRow(t *testing.T) {
	live := []PriceEntry{
		{Provider: "openai", Model: "gpt-4o", TokenType: "cache_write", USDPerMillion: 1.0, EffectiveStart: time.Now().UTC()},
	}
	candidate := []PriceEntry{}
	got := Diff(live, candidate, "https://example.test/feed.json", time.Now().UTC())
	if len(got.Changes) != 1 || got.Changes[0].Kind != "removed" {
		t.Fatalf("got %+v", got.Changes)
	}
}

func TestDiffIgnoresNonTrackedModels(t *testing.T) {
	live := []PriceEntry{
		{Provider: "openai", Model: "gpt-4.1", TokenType: "input", USDPerMillion: 2.0, EffectiveStart: time.Now().UTC()},
	}
	got := Diff(live, nil, "https://example.test/feed.json", time.Now().UTC())
	if len(got.Changes) != 0 {
		t.Fatalf("non-tracked models must not produce removed rows, got %+v", got.Changes)
	}
}

func TestPctChangeMath(t *testing.T) {
	old := 4.0
	newVal := 5.0
	pct := pctChange(old, newVal)
	if pct == nil || *pct != 25 {
		t.Fatalf("pct = %v, want 25", pct)
	}
}
