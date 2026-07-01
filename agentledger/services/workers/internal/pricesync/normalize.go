package pricesync

import (
	"log/slog"
	"math"
	"sort"
	"time"
)

// trackedModels maps upstream LiteLLM feed ids to curated short price-book keys.
// Only these ids are ingested; longer dated ids must never land in the book directly.
var trackedModels = map[string]ModelMap{
	"gpt-4o":            {Provider: "openai", Model: "gpt-4o"},
	"gpt-4o-mini":       {Provider: "openai", Model: "gpt-4o-mini"},
	"claude-sonnet-4-5": {Provider: "anthropic", Model: "claude-sonnet"},
	"claude-haiku-4-5":  {Provider: "anthropic", Model: "claude-haiku"},
}

var tokenCostFields = []struct {
	field     string
	tokenType string
	get       func(FeedModelEntry) *float64
}{
	{"input_cost_per_token", "input", func(e FeedModelEntry) *float64 { return e.InputCostPerToken }},
	{"output_cost_per_token", "output", func(e FeedModelEntry) *float64 { return e.OutputCostPerToken }},
	{"cache_read_input_token_cost", "cache_read", func(e FeedModelEntry) *float64 { return e.CacheReadInputTokenCost }},
	{"cache_creation_input_token_cost", "cache_write", func(e FeedModelEntry) *float64 { return e.CacheCreationInputTokenCost }},
}

// TrackedModels returns the configured feed-id allow-list (for tests and diff).
func TrackedModels() map[string]ModelMap {
	return trackedModels
}

// Normalize builds a candidate price book from the feed, merging unchanged rows from live.
func Normalize(feed map[string]FeedModelEntry, live []PriceEntry, runAt time.Time, feedURL string) []PriceEntry {
	liveIndex := indexLive(live)
	var out []PriceEntry

	for feedID, mapping := range trackedModels {
		entry, ok := feed[feedID]
		if !ok {
			continue
		}
		if entry.LitellmProvider != "" && entry.LitellmProvider != mapping.Provider {
			slog.Warn("pricesync provider mismatch; skipping feed model",
				"feed_id", feedID, "feed_provider", entry.LitellmProvider, "expected_provider", mapping.Provider)
			continue
		}

		for _, tf := range tokenCostFields {
			rate := tokenRatePerMillion(tf.get(entry))
			if rate == nil {
				continue
			}
			key := rowKey(mapping.Provider, mapping.Model, tf.tokenType)
			if prev, ok := liveIndex[key]; ok && ratesEqual(prev.USDPerMillion, *rate) {
				out = append(out, prev)
				continue
			}
			out = append(out, PriceEntry{
				Provider:       mapping.Provider,
				Model:          mapping.Model,
				TokenType:      tf.tokenType,
				USDPerMillion:  *rate,
				EffectiveStart: runAt.UTC(),
				Source:         feedURL,
			})
		}
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		if out[i].Model != out[j].Model {
			return out[i].Model < out[j].Model
		}
		return out[i].TokenType < out[j].TokenType
	})
	return out
}

func indexLive(live []PriceEntry) map[string]PriceEntry {
	m := make(map[string]PriceEntry, len(live))
	for _, e := range live {
		m[rowKey(e.Provider, e.Model, e.TokenType)] = e
	}
	return m
}

func rowKey(provider, model, tokenType string) string {
	return provider + "\x00" + model + "\x00" + tokenType
}

func tokenRatePerMillion(v *float64) *float64 {
	if v == nil || *v == 0 {
		return nil
	}
	r := math.Round(*v*1_000_000*1e6) / 1e6
	if r == 0 {
		return nil
	}
	return &r
}

func ratesEqual(a, b float64) bool {
	return math.Abs(a-b) < 1e-9
}
