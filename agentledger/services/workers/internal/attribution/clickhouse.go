// Package attribution correlates business outcomes to the agent runs that
// produced them, scoring an attribution_confidence (0..1) and stamping run_id
// back onto the outcomes table so v_unit_economics can join cost to outcome.
//
//	outcomes (run_id='', confidence=0) ┐
//	                                   ├─▶ [attribution] ─▶ outcomes (run_id, confidence)
//	agent_runs (completed)             ┘
package attribution

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// OutcomeRow carries every outcomes column. The matcher re-inserts the full row
// (run_id + attribution_confidence updated) into the ReplacingMergeTree, so all
// other columns must round-trip untouched (e.g. business_value_usd set later by
// ROI templates).
type OutcomeRow struct {
	OutcomeID             string  `json:"outcome_id"`
	TenantID              string  `json:"tenant_id"`
	TS                    string  `json:"ts"` // YYYY-MM-DD HH:MM:SS.000 (UTC)
	SourceSystem          string  `json:"source_system"`
	OutcomeType           string  `json:"outcome_type"`
	TeamID                string  `json:"team_id"`
	UserID                string  `json:"user_id"`
	RunID                 string  `json:"run_id"`
	BusinessValueUSD      float64 `json:"business_value_usd"`
	QualityScore          float64 `json:"quality_score"`
	AttributionConfidence float64 `json:"attribution_confidence"`
	CompletionStatus      string  `json:"completion_status"`
}

// RunRow carries the agent_runs fields used for correlation.
type RunRow struct {
	RunID     string `json:"run_id"`
	TenantID  string `json:"tenant_id"`
	UserID    string `json:"user_id"`
	EndedAt   string `json:"ended_at"` // YYYY-MM-DD HH:MM:SS.000 (UTC)
	Status    string `json:"status"`
	Objective string `json:"objective"`
	OutcomeID string `json:"outcome_id"` // SDK-asserted direct link, if any
}

// CHClient reads outcomes + runs and writes attributed outcomes. Abstracted so
// the Matcher can be unit-tested without a live ClickHouse.
type CHClient interface {
	FetchOutcomes(ctx context.Context, since string) ([]OutcomeRow, error)
	FetchRuns(ctx context.Context, since string) ([]RunRow, error)
	WriteOutcomes(ctx context.Context, rows []OutcomeRow) error
}

// HTTPClient talks to ClickHouse over HTTP (stdlib only; same approach as the
// reconcile + ch-insert workers). Reads use FORMAT JSONEachRow; the time bound is
// a server parameter ({since:DateTime64(3)}), never concatenated (rule 4).
type HTTPClient struct {
	baseURL  string
	db       string
	user     string
	password string
	client   *http.Client
}

func NewHTTPClient(baseURL, db, user, password string) *HTTPClient {
	return &HTTPClient{
		baseURL:  baseURL,
		db:       db,
		user:     user,
		password: password,
		client:   &http.Client{Timeout: 60 * time.Second},
	}
}

// FetchOutcomes reads the merged-latest outcome rows (FINAL) updated since the
// given timestamp.
func (h *HTTPClient) FetchOutcomes(ctx context.Context, since string) ([]OutcomeRow, error) {
	// Filter on the real DateTime64 column inside a subquery, then toString() it
	// outside — aliasing toString(ts) AS ts at the top level shadows the ts
	// column in WHERE, breaking the {since:DateTime64(3)} comparison (same gotcha
	// the reconcile worker documents).
	q := fmt.Sprintf(`SELECT outcome_id, tenant_id, toString(ts) AS ts, source_system,
		outcome_type, team_id, user_id, run_id, business_value_usd, quality_score,
		attribution_confidence, completion_status
		FROM (SELECT * FROM %s.outcomes FINAL WHERE ts >= {since:DateTime64(3)})
		FORMAT JSONEachRow`, h.db)
	var rows []OutcomeRow
	if err := h.query(ctx, q, since, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// FetchRuns reads completed agent runs (FINAL) that ended since the given
// timestamp — candidates for correlation.
func (h *HTTPClient) FetchRuns(ctx context.Context, since string) ([]RunRow, error) {
	// Subquery so the WHERE sees the real ended_at column, not the toString alias
	// (see FetchOutcomes).
	q := fmt.Sprintf(`SELECT run_id, tenant_id, user_id, toString(ended_at) AS ended_at,
		status, objective, outcome_id
		FROM (SELECT * FROM %s.agent_runs FINAL WHERE ended_at >= {since:DateTime64(3)} AND status = 'completed')
		FORMAT JSONEachRow`, h.db)
	var rows []RunRow
	if err := h.query(ctx, q, since, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// query issues a SELECT with a single {since:DateTime64(3)} bound parameter and
// decodes the JSONEachRow response into out (a pointer to a slice).
func (h *HTTPClient) query(ctx context.Context, q, since string, out any) error {
	params := url.Values{}
	params.Set("param_since", since)
	endpoint := h.baseURL + "/?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(q))
	if err != nil {
		return err
	}
	h.auth(req)
	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("clickhouse query: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("clickhouse query status %d: %s", resp.StatusCode, bytes.TrimSpace(body))
	}
	return decodeJSONEachRow(body, out)
}

// WriteOutcomes re-inserts full outcome rows; the outcomes ReplacingMergeTree
// collapses each (tenant_id, ts, outcome_id) to the last-inserted row.
func (h *HTTPClient) WriteOutcomes(ctx context.Context, rows []OutcomeRow) error {
	if len(rows) == 0 {
		return nil
	}
	var body bytes.Buffer
	enc := json.NewEncoder(&body)
	for _, r := range rows {
		if err := enc.Encode(r); err != nil {
			return err
		}
	}
	params := url.Values{}
	params.Set("query", fmt.Sprintf("INSERT INTO %s.outcomes FORMAT JSONEachRow", h.db))
	params.Set("input_format_skip_unknown_fields", "1")
	params.Set("date_time_input_format", "best_effort")
	endpoint := h.baseURL + "/?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	h.auth(req)
	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("clickhouse insert: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("clickhouse insert status %d: %s", resp.StatusCode, bytes.TrimSpace(msg))
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// Ping reports ClickHouse reachability for readiness checks.
func (h *HTTPClient) Ping(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.baseURL+"/ping", nil)
	if err != nil {
		return err
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("clickhouse ping status %d", resp.StatusCode)
	}
	return nil
}

func (h *HTTPClient) auth(req *http.Request) {
	if h.user != "" {
		req.Header.Set("X-ClickHouse-User", h.user)
	}
	if h.password != "" {
		req.Header.Set("X-ClickHouse-Key", h.password)
	}
}

// decodeJSONEachRow unmarshals a newline-delimited JSON body into out, a pointer
// to a slice of OutcomeRow or RunRow.
func decodeJSONEachRow(body []byte, out any) error {
	switch dst := out.(type) {
	case *[]OutcomeRow:
		for _, line := range splitNonEmpty(body) {
			var r OutcomeRow
			if err := json.Unmarshal(line, &r); err != nil {
				return fmt.Errorf("decode outcome row: %w", err)
			}
			*dst = append(*dst, r)
		}
	case *[]RunRow:
		for _, line := range splitNonEmpty(body) {
			var r RunRow
			if err := json.Unmarshal(line, &r); err != nil {
				return fmt.Errorf("decode run row: %w", err)
			}
			*dst = append(*dst, r)
		}
	default:
		return fmt.Errorf("unsupported decode target %T", out)
	}
	return nil
}

func splitNonEmpty(body []byte) [][]byte {
	var out [][]byte
	for _, line := range bytes.Split(bytes.TrimSpace(body), []byte("\n")) {
		if len(bytes.TrimSpace(line)) > 0 {
			out = append(out, line)
		}
	}
	return out
}
