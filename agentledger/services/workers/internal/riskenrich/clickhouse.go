package riskenrich

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

// AgentBehavior is one run's observed tool/MCP usage, summarized as metadata for
// the classifier — the ordered tool sequence, the MCP servers seen, and the call
// count. No prompt/completion content is ever included (CLAUDE.md rule 2).
type AgentBehavior struct {
	TenantID   string   `json:"tenant_id"`
	AgentID    string   `json:"agent_id"`
	RunID      string   `json:"run_id"`
	Tools      []string `json:"tools"`
	MCPServers []string `json:"mcp_servers"`
	CallCount  uint64   `json:"call_count"`
}

// RiskEvent is one governed risk event written to risk_events (shared with the
// deterministic tier; semantic events use category "semantic_*").
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

// CHClient reads recent agent behaviors and writes semantic risk events.
// Abstracted so the Engine can be unit-tested without a live ClickHouse.
type CHClient interface {
	AgentBehaviors(ctx context.Context, lookbackHours, minCalls int) ([]AgentBehavior, error)
	WriteRiskEvents(ctx context.Context, events []RiskEvent) error
}

// HTTPClient talks to ClickHouse over HTTP (stdlib only; same approach as the
// risk-engine and reconcile workers).
type HTTPClient struct {
	baseURL  string
	db       string
	user     string
	password string
	client   *http.Client
}

// NewHTTPClient builds an HTTPClient for the ClickHouse HTTP interface used by
// the semantic risk-enrichment worker.
func NewHTTPClient(baseURL, db, user, password string) *HTTPClient {
	return &HTTPClient{baseURL: baseURL, db: db, user: user, password: password, client: &http.Client{Timeout: 60 * time.Second}}
}

// AgentBehaviors returns per-(tenant, agent, run) tool-call sequences observed in
// the last lookbackHours, restricted to runs with at least minCalls tool calls.
// groupArray over a ts-ordered subquery preserves call order.
func (h *HTTPClient) AgentBehaviors(ctx context.Context, lookbackHours, minCalls int) ([]AgentBehavior, error) {
	q := fmt.Sprintf(`SELECT tenant_id, agent_id, run_id,
			groupArray(tool_name) AS tools,
			arrayFilter(x -> x != '', groupUniqArray(mcp_server)) AS mcp_servers,
			count() AS call_count
		FROM (
			SELECT tenant_id, agent_id, run_id, tool_name, mcp_server, ts
			FROM %s.agent_tool_calls FINAL
			WHERE ts >= now() - INTERVAL %d HOUR
			ORDER BY ts
		)
		GROUP BY tenant_id, agent_id, run_id
		HAVING call_count >= %d
		SETTINGS output_format_json_quote_64bit_integers = 0
		FORMAT JSONEachRow`, h.db, lookbackHours, minCalls)
	body, err := h.queryRaw(ctx, q)
	if err != nil {
		return nil, err
	}
	var rows []AgentBehavior
	return rows, decodeLines(body, &rows)
}

// WriteRiskEvents inserts semantic risk events into ClickHouse.
func (h *HTTPClient) WriteRiskEvents(ctx context.Context, events []RiskEvent) error {
	return h.insert(ctx, "risk_events", toJSONL(events))
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
