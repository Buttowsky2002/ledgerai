// Package riskengine is the Agent-Native Risk Engine worker (Phase 5): it
// observes per-agent tool/MCP usage, flags calls outside the deny-by-default
// allowlist as governed risk events, and rolls each agent's exposure into the
// agent_risk table that v_roi turns into risk-adjusted ROI.
//
//	agent_tool_calls ┐
//	                 ├─▶ v_unauthorized_tools / v_agent_tool_exposure ─▶ [risk-engine]
//	agent_tool_allow ┘                                          ├─▶ risk_events
//	                                                            └─▶ agent_risk
package riskengine

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

// UnauthorizedTool is one (agent, tool) the allowlist does not permit.
type UnauthorizedTool struct {
	TenantID    string `json:"tenant_id"`
	AgentID     string `json:"agent_id"`
	ToolName    string `json:"tool_name"`
	FirstSeen   string `json:"first_seen"`
	Occurrences uint32 `json:"occurrences"`
}

// AgentExposure is one agent's unauthorized-vs-total tool-call ratio.
type AgentExposure struct {
	TenantID          string  `json:"tenant_id"`
	AgentID           string  `json:"agent_id"`
	TotalCalls        uint64  `json:"total_calls"`
	UnauthorizedCalls uint64  `json:"unauthorized_calls"`
	ExposurePct       float64 `json:"exposure_pct"`
}

// RiskEvent is one governed risk event written to risk_events.
type RiskEvent struct {
	EventID     string `json:"event_id"`
	TenantID    string `json:"tenant_id"`
	AgentID     string `json:"agent_id"`
	RunID       string `json:"run_id"`
	Category    string `json:"category"`
	Severity    string `json:"severity"`
	Detail      string `json:"detail"`
	Occurrences uint32 `json:"occurrences"`
	FirstSeen   string `json:"first_seen"`
	DetectedAt  string `json:"detected_at"`
}

// AgentRisk is one row written to agent_risk (consumed by v_roi).
type AgentRisk struct {
	TenantID        string  `json:"tenant_id"`
	AgentID         string  `json:"agent_id"`
	RiskExposurePct float64 `json:"risk_exposure_pct"`
	UpdatedAt       string  `json:"updated_at"`
}

// CHClient reads the governance views and writes risk events + agent risk.
// Abstracted so the Engine can be unit-tested without a live ClickHouse.
type CHClient interface {
	UnauthorizedTools(ctx context.Context) ([]UnauthorizedTool, error)
	AgentExposure(ctx context.Context) ([]AgentExposure, error)
	WriteRiskEvents(ctx context.Context, events []RiskEvent) error
	WriteAgentRisk(ctx context.Context, rows []AgentRisk) error
}

// HTTPClient talks to ClickHouse over HTTP (stdlib only; same approach as the
// reconcile worker).
type HTTPClient struct {
	baseURL  string
	db       string
	user     string
	password string
	client   *http.Client
}

// NewHTTPClient builds an HTTPClient for the ClickHouse HTTP interface used by
// the risk engine.
func NewHTTPClient(baseURL, db, user, password string) *HTTPClient {
	return &HTTPClient{baseURL: baseURL, db: db, user: user, password: password, client: &http.Client{Timeout: 60 * time.Second}}
}

// UnauthorizedTools returns observed tool calls that are not on any agent's
// allowlist, with occurrence counts.
func (h *HTTPClient) UnauthorizedTools(ctx context.Context) ([]UnauthorizedTool, error) {
	body, err := h.queryRaw(ctx, fmt.Sprintf(`SELECT tenant_id, agent_id, tool_name, toString(first_seen) AS first_seen, occurrences
		FROM %s.v_unauthorized_tools
		SETTINGS output_format_json_quote_64bit_integers = 0 FORMAT JSONEachRow`, h.db))
	if err != nil {
		return nil, err
	}
	var rows []UnauthorizedTool
	return rows, decodeLines(body, &rows)
}

// AgentExposure returns each agent's total vs unauthorized tool-call counts and
// exposure percentage.
func (h *HTTPClient) AgentExposure(ctx context.Context) ([]AgentExposure, error) {
	body, err := h.queryRaw(ctx, fmt.Sprintf(`SELECT tenant_id, agent_id, total_calls, unauthorized_calls, exposure_pct
		FROM %s.v_agent_tool_exposure
		SETTINGS output_format_json_quote_64bit_integers = 0 FORMAT JSONEachRow`, h.db))
	if err != nil {
		return nil, err
	}
	var rows []AgentExposure
	return rows, decodeLines(body, &rows)
}

// WriteRiskEvents inserts generated risk events into ClickHouse.
func (h *HTTPClient) WriteRiskEvents(ctx context.Context, events []RiskEvent) error {
	return h.insert(ctx, "risk_events", toJSONL(events))
}

// WriteAgentRisk upserts per-agent risk-exposure rows consumed by the ROI engine.
func (h *HTTPClient) WriteAgentRisk(ctx context.Context, rows []AgentRisk) error {
	return h.insert(ctx, "agent_risk", toJSONL(rows))
}

func toJSONL[T any](rows []T) *bytes.Buffer {
	var body bytes.Buffer
	enc := json.NewEncoder(&body)
	for _, r := range rows {
		_ = enc.Encode(r)
	}
	return &body
}

func (h *HTTPClient) queryRaw(ctx context.Context, q string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.baseURL+"/", bytes.NewReader([]byte(q)))
	if err != nil {
		return nil, err
	}
	h.auth(req)
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("clickhouse query: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("clickhouse query status %d: %s", resp.StatusCode, bytes.TrimSpace(body))
	}
	return body, nil
}

func decodeLines[T any](body []byte, out *[]T) error {
	for _, line := range bytes.Split(bytes.TrimSpace(body), []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var r T
		if err := json.Unmarshal(line, &r); err != nil {
			return fmt.Errorf("decode row: %w", err)
		}
		*out = append(*out, r)
	}
	return nil
}

func (h *HTTPClient) insert(ctx context.Context, table string, body *bytes.Buffer) error {
	if body.Len() == 0 {
		return nil
	}
	params := url.Values{}
	params.Set("query", fmt.Sprintf("INSERT INTO %s.%s FORMAT JSONEachRow", h.db, table))
	params.Set("input_format_skip_unknown_fields", "1")
	params.Set("date_time_input_format", "best_effort")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.baseURL+"/?"+params.Encode(), body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	h.auth(req)
	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("clickhouse insert %s: %w", table, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("clickhouse insert %s status %d: %s", table, resp.StatusCode, bytes.TrimSpace(msg))
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
	defer func() { _ = resp.Body.Close() }()
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
