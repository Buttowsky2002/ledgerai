package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// PriceBook implements versioned, effective-dated pricing per (provider,
// model, token_type), aligned with the FOCUS 1.2 idea of pricing in
// non-monetary units (tokens) converted to currency with auditable rates.
//
// Token types follow provider billing semantics: input, output,
// cache_read, cache_write. Prices are USD per 1M tokens.

// PriceEntry is one price-book row: a provider/model/token-type rate effective
// over a time window.
type PriceEntry struct {
	Provider       string     `json:"provider"`
	Model          string     `json:"model"` // prefix match, longest wins
	TokenType      string     `json:"token_type"`
	USDPerMillion  float64    `json:"usd_per_million"`
	EffectiveStart time.Time  `json:"effective_start"`
	EffectiveEnd   *time.Time `json:"effective_end,omitempty"`
	Source         string     `json:"source"` // provenance for audit
}

// PriceBook is an in-memory collection of PriceEntry rows queried by Rate.
type PriceBook struct {
	entries []PriceEntry
}

// LoadPriceBook reads and parses the price book from a JSON file.
func LoadPriceBook(path string) (*PriceBook, error) {
	b, err := os.ReadFile(path) // #nosec G304 -- path is an operator-provided price-book file path set at startup, not user input
	if err != nil {
		return nil, fmt.Errorf("read price book: %w", err)
	}
	var entries []PriceEntry
	if err := json.Unmarshal(b, &entries); err != nil {
		return nil, fmt.Errorf("parse price book: %w", err)
	}
	return &PriceBook{entries: entries}, nil
}

// Rate returns USD-per-million for the best matching entry effective at t.
func (p *PriceBook) Rate(provider, model, tokenType string, t time.Time) (float64, bool) {
	bestLen := -1
	var rate float64
	found := false
	for _, e := range p.entries {
		if e.Provider != provider || e.TokenType != tokenType {
			continue
		}
		if !strings.HasPrefix(model, e.Model) {
			continue
		}
		if t.Before(e.EffectiveStart) {
			continue
		}
		if e.EffectiveEnd != nil && t.After(*e.EffectiveEnd) {
			continue
		}
		if len(e.Model) > bestLen {
			bestLen = len(e.Model)
			rate = e.USDPerMillion
			found = true
		}
	}
	return rate, found
}

// Usage mirrors OpenAI-compatible usage blocks, including cached tokens.
type Usage struct {
	InputTokens      int `json:"prompt_tokens"`
	OutputTokens     int `json:"completion_tokens"`
	CacheReadTokens  int `json:"-"`
	CacheWriteTokens int `json:"-"`
}

// Cost computes the realized USD cost of a call. Cached input tokens are
// priced at the cache_read rate and subtracted from the input rate.
func (p *PriceBook) Cost(provider, model string, u Usage, t time.Time) float64 {
	var total float64
	billableInput := u.InputTokens - u.CacheReadTokens
	if billableInput < 0 {
		billableInput = 0
	}
	add := func(tokenType string, n int) {
		if n <= 0 {
			return
		}
		if r, ok := p.Rate(provider, model, tokenType, t); ok {
			total += float64(n) * r / 1_000_000
		}
	}
	add("input", billableInput)
	add("cache_read", u.CacheReadTokens)
	add("cache_write", u.CacheWriteTokens)
	add("output", u.OutputTokens)
	return total
}
