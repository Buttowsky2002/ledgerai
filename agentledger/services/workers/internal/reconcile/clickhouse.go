// Package reconcile diffs gateway-observed cost against provider-billed cost
// (from the connector pipeline), books per-day/model adjustments, and flags
// material drift.
package reconcile

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

// ReconRow is one row of the v_cost_reconciliation view.
type ReconRow struct {
	TenantID        string  `json:"tenant_id"`
	Day             string  `json:"day"`
	Model           string  `json:"model"`
	VirtualKeyID    string  `json:"virtual_key_id"`
	GatewayCostUSD  float64 `json:"gateway_cost_usd"`
	ProviderCostUSD float64 `json:"provider_cost_usd"`
	DriftUSD        float64 `json:"drift_usd"`
	DriftPct        float64 `json:"drift_pct"`
}

// Adjustment is one booked reconciliation row, written to cost_adjustments.
type Adjustment struct {
	TenantID        string  `json:"tenant_id"`
	Day             string  `json:"day"`
	Model           string  `json:"model"`
	VirtualKeyID    string  `json:"virtual_key_id"`
	GatewayCostUSD  float64 `json:"gateway_cost_usd"`
	ProviderCostUSD float64 `json:"provider_cost_usd"`
	DriftUSD        float64 `json:"drift_usd"`
	DriftPct        float64 `json:"drift_pct"`
	Flagged         uint8   `json:"flagged"`
	ThresholdPct    float64 `json:"threshold_pct"`
	ReconciledAt    string  `json:"reconciled_at"`
}

// CHClient reads the reconciliation view and writes adjustments. Abstracted so
// the Reconciler can be unit-tested without a live ClickHouse.
type CHClient interface {
	Reconciliation(ctx context.Context, sinceDay string) ([]ReconRow, error)
	WriteAdjustments(ctx context.Context, adj []Adjustment) error
}

// HTTPClient talks to ClickHouse over HTTP (stdlib only; same approach as the
// ch-insert worker). Reads use FORMAT JSONEachRow; the date bound is a server
// parameter ({since:Date}), never concatenated (rule 4).
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

func (h *HTTPClient) Reconciliation(ctx context.Context, sinceDay string) ([]ReconRow, error) {
	// Filter on the Date column inside a subquery, then stringify outside —
	// aliasing toString(day) AS day at the top level would shadow the Date
	// column in WHERE and break the {since:Date} comparison.
	q := fmt.Sprintf(`SELECT tenant_id, toString(day) AS day, model, virtual_key_id,
		gateway_cost_usd, provider_cost_usd, drift_usd, drift_pct
		FROM (SELECT * FROM %s.v_cost_reconciliation WHERE day >= {since:Date})
		FORMAT JSONEachRow`, h.db)

	params := url.Values{}
	params.Set("param_since", sinceDay)
	endpoint := h.baseURL + "/?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(q))
	if err != nil {
		return nil, err
	}
	h.auth(req)
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("clickhouse query: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("clickhouse query status %d: %s", resp.StatusCode, bytes.TrimSpace(body))
	}

	var rows []ReconRow
	for _, line := range bytes.Split(bytes.TrimSpace(body), []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var r ReconRow
		if err := json.Unmarshal(line, &r); err != nil {
			return nil, fmt.Errorf("decode recon row: %w", err)
		}
		rows = append(rows, r)
	}
	return rows, nil
}

func (h *HTTPClient) WriteAdjustments(ctx context.Context, adj []Adjustment) error {
	if len(adj) == 0 {
		return nil
	}
	var body bytes.Buffer
	enc := json.NewEncoder(&body)
	for _, a := range adj {
		if err := enc.Encode(a); err != nil {
			return err
		}
	}
	params := url.Values{}
	params.Set("query", fmt.Sprintf("INSERT INTO %s.cost_adjustments FORMAT JSONEachRow", h.db))
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

// abs is a tiny helper used by the reconciler.
func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}
