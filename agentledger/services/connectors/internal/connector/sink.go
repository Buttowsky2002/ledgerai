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

// Sink persists normalized provider-cost records.
type Sink interface {
	Write(ctx context.Context, records []Record) error
}

// ClickHouseSink writes records into agentledger.provider_costs via the
// ClickHouse HTTP JSONEachRow interface — stdlib only, no CH driver (matching
// the ch-insert worker). Re-importing a day produces identical ordering-key
// rows that ReplacingMergeTree collapses, so the sink is idempotent.
type ClickHouseSink struct {
	baseURL  string
	db       string
	table    string
	user     string
	password string
	client   *http.Client
	now      func() time.Time
}

// NewClickHouseSink builds a sink that writes provider_costs rows via the
// ClickHouse HTTP interface.
func NewClickHouseSink(baseURL, db, user, password string) *ClickHouseSink {
	return &ClickHouseSink{
		baseURL:  baseURL,
		db:       db,
		table:    "provider_costs",
		user:     user,
		password: password,
		client:   &http.Client{Timeout: 30 * time.Second},
		now:      time.Now,
	}
}

// chRow is a provider_costs row on the wire: Record fields plus the
// ReplacingMergeTree version column.
type chRow struct {
	Record
	ImportedAt string `json:"imported_at"`
}

func (s *ClickHouseSink) Write(ctx context.Context, records []Record) error {
	if len(records) == 0 {
		return nil
	}
	stamp := s.now().UTC().Format("2006-01-02 15:04:05.000")

	var body bytes.Buffer
	enc := json.NewEncoder(&body)
	for _, r := range records {
		if r.Currency == "" {
			r.Currency = "USD"
		}
		if err := enc.Encode(chRow{Record: r, ImportedAt: stamp}); err != nil {
			return fmt.Errorf("encode record: %w", err)
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
