// Package forward delivers normalized canonical events from an ingestion
// adapter to the collector's HTTP ingest endpoint (POST /v1/events). Keeping
// adapters thin — they normalize and forward — means the collector remains the
// single place that schema-validates and produces to Redpanda, so untrusted
// third-party data is gated at one boundary (CLAUDE.md rule 15).
package forward

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client posts batches of canonical events to the collector. It is safe for
// concurrent use.
type Client struct {
	url        string
	http       *http.Client
	maxRetries int
	backoff    time.Duration
}

// New builds a forwarder targeting collectorURL (the full /v1/events URL).
func New(collectorURL string) *Client {
	return &Client{
		url:        collectorURL,
		http:       &http.Client{Timeout: 10 * time.Second},
		maxRetries: 4,
		backoff:    200 * time.Millisecond,
	}
}

// Send posts the events as a JSON array. The collector returns 202 on accept
// and 429 under backpressure; on 429 we retry with linear backoff (the
// collector is non-blocking by design, so a retry is the correct response).
// Returns an error if the batch is not accepted within maxRetries.
func (c *Client) Send(ctx context.Context, events []map[string]any) error {
	if len(events) == 0 {
		return nil
	}
	body, err := json.Marshal(events)
	if err != nil {
		return fmt.Errorf("marshal events: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt <= c.maxRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(c.backoff * time.Duration(attempt)):
			}
		}
		status, respBody, err := c.post(ctx, body)
		if err != nil {
			lastErr = err
			continue
		}
		switch {
		case status == http.StatusAccepted, status >= 200 && status < 300:
			return nil
		case status == http.StatusTooManyRequests:
			lastErr = fmt.Errorf("collector backpressure (429)")
			continue
		default:
			// 4xx other than 429 won't succeed on retry (e.g. validation 422).
			return fmt.Errorf("collector rejected batch: status %d: %s", status, truncate(respBody, 256))
		}
	}
	return fmt.Errorf("forward failed after %d retries: %w", c.maxRetries, lastErr)
}

func (c *Client) post(ctx context.Context, body []byte) (int, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return resp.StatusCode, string(b), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
