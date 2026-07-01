// Package connector is the BadgerIQ provider-cost connector framework:
// cursor-based incremental sync, per-connector rate limiting, retries with
// jitter, and Postgres-persisted state. Provider importers (OpenAI, Anthropic,
// Bedrock, Vertex) implement Connector; the Syncer drives them.
package connector

import "context"

// Cursor is an opaque, per-connector incremental-sync watermark. It is
// JSON-serialized into connectors.sync_cursor so a sync resumes where it left
// off after a crash or restart. An empty Value means "from the beginning".
type Cursor struct {
	Value map[string]any `json:"value,omitempty"`
}

// IsZero reports whether the cursor carries no watermark yet.
func (c Cursor) IsZero() bool { return len(c.Value) == 0 }

// Record is one normalized provider-billed cost line, destined for the
// ClickHouse provider_costs table. Connectors translate provider-specific
// payloads into this shape; nothing downstream knows provider formats.
type Record struct {
	TenantID     string  `json:"tenant_id"`
	Day          string  `json:"day"` // YYYY-MM-DD
	Provider     string  `json:"provider"`
	Model        string  `json:"model"`
	LineItem     string  `json:"line_item"`
	VirtualKeyID string  `json:"virtual_key_id"`
	InputTokens  uint64  `json:"input_tokens"`
	OutputTokens uint64  `json:"output_tokens"`
	CostUSD      float64 `json:"cost_usd"`
	Currency     string  `json:"currency"`
	Source       string  `json:"source"` // connector kind
}

// Page is one batch of records plus the cursor to resume from. Done signals the
// sync has reached the end of available data for this run.
type Page struct {
	Records []Record
	Next    Cursor
	Done    bool
}

// Connector incrementally pulls provider-billed cost data. Implementations must
// be stateless across calls — all resumable state travels through the Cursor —
// so a sync can crash mid-run and resume from the last persisted cursor.
type Connector interface {
	// Kind is the stable connector type, matching connectors.kind in Postgres
	// (e.g. "openai_usage").
	Kind() string
	// Fetch returns the next page of records at or after cur. The returned
	// Page.Next must be persisted only after its Records are durably written
	// (the Syncer guarantees this ordering for crash-safe replay).
	Fetch(ctx context.Context, cfg map[string]any, cur Cursor) (Page, error)
}
