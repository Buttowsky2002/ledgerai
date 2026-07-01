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

// FixedCostRecord is one row in agentledger.fixed_costs. attributable is always 0.
type FixedCostRecord struct {
	TenantID     string  `json:"tenant_id"`
	PeriodMonth  string  `json:"period_month"` // YYYY-MM-DD (first of month)
	Vendor       string  `json:"vendor"`
	CostType     string  `json:"cost_type"`
	LineItem     string  `json:"line_item,omitempty"`
	Seats        uint32  `json:"seats,omitempty"`
	UnitCostUSD  float64 `json:"unit_cost_usd,omitempty"`
	CostUSD      float64 `json:"cost_usd"`
	Currency     string  `json:"currency,omitempty"`
	Attributable uint8   `json:"attributable"`
	Source       string  `json:"source"`
	Note         string  `json:"note,omitempty"`
}

// FixedCostSink writes fixed_costs rows via ClickHouse HTTP JSONEachRow.
type FixedCostSink struct {
	baseURL  string
	db       string
	table    string
	user     string
	password string
	client   *http.Client
	now      func() time.Time
}

// NewFixedCostSink builds a sink for agentledger.fixed_costs.
func NewFixedCostSink(baseURL, db, user, password string) *FixedCostSink {
	return &FixedCostSink{
		baseURL:  baseURL,
		db:       db,
		table:    "fixed_costs",
		user:     user,
		password: password,
		client:   &http.Client{Timeout: 30 * time.Second},
		now:      time.Now,
	}
}

// HTTPClient exposes the configured client (for tests).
func (s *FixedCostSink) HTTPClient() *http.Client {
	return s.client
}

type fixedCostCHRow struct {
	FixedCostRecord
	ImportedAt string `json:"imported_at"`
}

// Write persists records; re-importing the same identity replaces via ReplacingMergeTree.
func (s *FixedCostSink) Write(ctx context.Context, records []FixedCostRecord) error {
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
		r.Attributable = 0
		if err := enc.Encode(fixedCostCHRow{FixedCostRecord: r, ImportedAt: stamp}); err != nil {
			return fmt.Errorf("encode fixed cost record: %w", err)
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
		return fmt.Errorf("clickhouse fixed_costs write: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("clickhouse fixed_costs write status %d: %s", resp.StatusCode, bytes.TrimSpace(msg))
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}
