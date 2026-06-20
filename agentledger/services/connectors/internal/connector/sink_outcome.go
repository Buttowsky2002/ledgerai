package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// ClickHouseOutcomeSink writes OutcomeRecords into agentledger.outcomes via the
// ClickHouse HTTP JSONEachRow interface — stdlib only, mirroring ClickHouseSink.
// outcomes is a ReplacingMergeTree ordered by (tenant_id, ts, outcome_id), so
// re-importing the same source objects collapses to one row per outcome_id.
type ClickHouseOutcomeSink struct {
	baseURL  string
	db       string
	table    string
	user     string
	password string
	client   *http.Client
}

// NewClickHouseOutcomeSink builds a sink that writes outcomes rows via the
// ClickHouse HTTP interface.
func NewClickHouseOutcomeSink(baseURL, db, user, password string) *ClickHouseOutcomeSink {
	return &ClickHouseOutcomeSink{
		baseURL:  baseURL,
		db:       db,
		table:    "outcomes",
		user:     user,
		password: password,
		client:   &http.Client{Timeout: 30 * time.Second},
	}
}

// WriteOutcomes inserts outcome records into ClickHouse.
func (s *ClickHouseOutcomeSink) WriteOutcomes(ctx context.Context, records []OutcomeRecord) error {
	if len(records) == 0 {
		return nil
	}

	var body bytes.Buffer
	enc := json.NewEncoder(&body)
	for _, r := range records {
		if r.CompletionStatus == "" {
			r.CompletionStatus = "completed"
		}
		if err := enc.Encode(r); err != nil {
			return fmt.Errorf("encode outcome: %w", err)
		}
	}

	q := url.Values{}
	q.Set("query", fmt.Sprintf("INSERT INTO %s.%s FORMAT JSONEachRow", s.db, s.table))
	q.Set("input_format_skip_unknown_fields", "1")
	q.Set("date_time_input_format", "best_effort")
	endpoint := s.baseURL + "/?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	if s.user != "" {
		req.Header.Set("X-ClickHouse-User", s.user)
	}
	if s.password != "" {
		req.Header.Set("X-ClickHouse-Key", s.password)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("clickhouse write: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("clickhouse write status %d: %s", resp.StatusCode, bytes.TrimSpace(msg))
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}
