package slackalert

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// SlackNotifier posts messages to a Slack incoming webhook over stdlib net/http
// (no SDK, rule 12). The webhook URL comes from an env-var NAME only (rule 1); an
// empty URL disables alerting (Enabled() == false), so the worker runs as a no-op
// until a webhook is configured.
type SlackNotifier struct {
	webhookURL string
	client     *http.Client
}

// NewSlackNotifier builds a notifier; an empty webhookURL disables posting.
func NewSlackNotifier(webhookURL string) *SlackNotifier {
	return &SlackNotifier{webhookURL: webhookURL, client: &http.Client{Timeout: 10 * time.Second}}
}

// Enabled reports whether a webhook is configured.
func (s *SlackNotifier) Enabled() bool { return s.webhookURL != "" }

// Post sends a single text message, retrying transient failures with backoff.
func (s *SlackNotifier) Post(ctx context.Context, text string) error {
	payload, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return err
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
			}
		}
		if lastErr = s.post(ctx, payload); lastErr == nil {
			return nil
		}
	}
	return lastErr
}

func (s *SlackNotifier) post(ctx context.Context, payload []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.webhookURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("slack webhook status %d", resp.StatusCode)
	}
	return nil
}
