package pricesync

import (
	"sync/atomic"
	"time"
)

// PriceEntry mirrors services/gateway/pricing.go PriceEntry. The gateway type lives in package
// main and cannot be imported; this copy MUST stay tag- and shape-compatible. types_test.go
// round-trips the live price book to enforce it.
type PriceEntry struct {
	Provider       string     `json:"provider"`
	Model          string     `json:"model"`
	TokenType      string     `json:"token_type"`
	USDPerMillion  float64    `json:"usd_per_million"`
	EffectiveStart time.Time  `json:"effective_start"`
	EffectiveEnd   *time.Time `json:"effective_end,omitempty"`
	Source         string     `json:"source"`
}

// FeedModelEntry holds only the LiteLLM feed fields used for normalization.
type FeedModelEntry struct {
	LitellmProvider             string   `json:"litellm_provider"`
	InputCostPerToken           *float64 `json:"input_cost_per_token"`
	OutputCostPerToken          *float64 `json:"output_cost_per_token"`
	CacheReadInputTokenCost     *float64 `json:"cache_read_input_token_cost"`
	CacheCreationInputTokenCost *float64 `json:"cache_creation_input_token_cost"`
}

// ModelMap maps an upstream feed model id to the curated short price-book key.
type ModelMap struct {
	Provider string
	Model    string
}

// Metrics holds pricesync counters (atomic).
type Metrics struct {
	Runs        atomic.Int64
	Changes     atomic.Int64
	Changed     atomic.Int64
	Removed     atomic.Int64
	FetchErrors atomic.Int64
	LastRunUnix atomic.Int64
}
