package pricesync

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const defaultFeedURL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

// Fetcher downloads and parses the upstream LiteLLM list-price feed.
type Fetcher struct {
	client  *http.Client
	url     string
	metrics *Metrics
}

// NewFetcher builds a Fetcher with an explicit timeout (never http.DefaultClient).
func NewFetcher(url string, timeout time.Duration, metrics *Metrics) *Fetcher {
	if metrics == nil {
		metrics = &Metrics{}
	}
	if url == "" {
		url = defaultFeedURL
	}
	return &Fetcher{
		client:  &http.Client{Timeout: timeout},
		url:     url,
		metrics: metrics,
	}
}

// HTTPClient exposes the configured client (for tests).
func (f *Fetcher) HTTPClient() *http.Client {
	return f.client
}

// FeedURL returns the configured upstream URL.
func (f *Fetcher) FeedURL() string {
	return f.url
}

// Fetch downloads the feed and returns parsed model entries keyed by feed id.
func (f *Fetcher) Fetch(ctx context.Context) (map[string]FeedModelEntry, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.url, nil)
	if err != nil {
		return nil, fmt.Errorf("build feed request: %w", err)
	}

	resp, err := f.client.Do(req)
	if err != nil {
		f.metrics.FetchErrors.Add(1)
		return nil, fmt.Errorf("fetch feed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		f.metrics.FetchErrors.Add(1)
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, fmt.Errorf("fetch feed: HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		f.metrics.FetchErrors.Add(1)
		return nil, fmt.Errorf("read feed body: %w", err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		f.metrics.FetchErrors.Add(1)
		return nil, fmt.Errorf("parse feed json: %w", err)
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
