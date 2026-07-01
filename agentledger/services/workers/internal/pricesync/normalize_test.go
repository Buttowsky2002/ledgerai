package pricesync

import (
	"testing"
	"time"
)

func TestTokenRatePerMillion(t *testing.T) {
	v := 1.5e-07
	got := tokenRatePerMillion(&v)
	if got == nil {
		t.Fatal("expected rate")
	}
	if *got != 0.15 {
		t.Fatalf("got %v, want 0.15", *got)
	}
}

func TestTokenRatePerMillionSkipsZeroAndNil(t *testing.T) {
	zero := 0.0
	if tokenRatePerMillion(&zero) != nil {
		t.Fatal("zero rate should be skipped")
	}
	if tokenRatePerMillion(nil) != nil {
		t.Fatal("nil rate should be skipped")
	}
}

func TestNormalizeCarriesUnchangedRows(t *testing.T) {
	feed, err := loadTestFeedFromFile("testdata/feed.json")
	if err != nil {
		t.Fatal(err)
	}
	live, err := LoadPriceBook("testdata/live_pricebook.json")
	if err != nil {
		t.Fatal(err)
	}
	runAt := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	out := Normalize(feed, live, runAt, "https://example.test/feed.json")

	liveByKey := indexByRow(live)
	for _, e := range out {
		prev, ok := liveByKey[rowKey(e.Provider, e.Model, e.TokenType)]
		if !ok {
			continue
		}
		if ratesEqual(prev.USDPerMillion, e.USDPerMillion) {
			if !prev.EffectiveStart.Equal(e.EffectiveStart) || prev.Source != e.Source {
				t.Fatalf("unchanged row should carry live metadata verbatim: %+v", e)
			}
		}
	}
}

func TestNormalizeSetsEffectiveStartOnChangedRows(t *testing.T) {
	feed, err := loadTestFeedFromFile("testdata/feed.json")
	if err != nil {
		t.Fatal(err)
	}
	live, err := LoadPriceBook("testdata/live_pricebook.json")
	if err != nil {
		t.Fatal(err)
	}
	runAt := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	out := Normalize(feed, live, runAt, "https://example.test/feed.json")

	var haikuInput *PriceEntry
	for i := range out {
		e := out[i]
		if e.Provider == "anthropic" && e.Model == "claude-haiku" && e.TokenType == "input" {
			haikuInput = &out[i]
			break
		}
	}
	if haikuInput == nil {
		t.Fatal("expected claude-haiku input row")
	}
	if !haikuInput.EffectiveStart.Equal(runAt) {
		t.Fatalf("effective_start = %v, want %v", haikuInput.EffectiveStart, runAt)
	}
	if haikuInput.Source != "https://example.test/feed.json" {
		t.Fatalf("source = %q", haikuInput.Source)
	}
}

func TestNormalizeExcludesUntrackedModels(t *testing.T) {
	feed := map[string]FeedModelEntry{
		"untracked-model-xyz": {
			LitellmProvider:    "openai",
			InputCostPerToken:  fp(1e-06),
			OutputCostPerToken: fp(2e-06),
		},
	}
	out := Normalize(feed, nil, time.Now().UTC(), "https://example.test/feed.json")
	if len(out) != 0 {
		t.Fatalf("untracked models must not appear, got %d rows", len(out))
	}
}

func TestNormalizeSkipsProviderMismatch(t *testing.T) {
	feed := map[string]FeedModelEntry{
		"claude-haiku-4-5": {
			LitellmProvider:    "bedrock",
			InputCostPerToken:  fp(1e-06),
			OutputCostPerToken: fp(5e-06),
		},
	}
	out := Normalize(feed, nil, time.Now().UTC(), "https://example.test/feed.json")
	for _, e := range out {
		if e.Model == "claude-haiku" {
			t.Fatal("provider mismatch row must be skipped")
		}
	}
}

func TestNormalizeNoZeroRows(t *testing.T) {
	feed := map[string]FeedModelEntry{
		"gpt-4o": {
			LitellmProvider:    "openai",
			InputCostPerToken:  fp(2.5e-06),
			OutputCostPerToken: fp(0),
		},
	}
	out := Normalize(feed, nil, time.Now().UTC(), "https://example.test/feed.json")
	for _, e := range out {
		if e.TokenType == "output" {
			t.Fatal("zero output rate must not emit a row")
		}
		if e.USDPerMillion == 0 {
			t.Fatal("must never emit 0.0 usd_per_million row")
		}
	}
}

func fp(v float64) *float64 { return &v }

func loadTestFeedFromFile(path string) (map[string]FeedModelEntry, error) {
	return loadTestFeedFromPath(path)
}
