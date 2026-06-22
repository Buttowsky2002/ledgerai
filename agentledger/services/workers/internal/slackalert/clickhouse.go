package slackalert

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

// CHClient reads spend (per budget scope) and critical risk events from
// ClickHouse over HTTP (stdlib only; same approach as the risk-engine worker).
// All scope/date values are bound as ClickHouse parameters — never interpolated
// into SQL (rule 4).
type CHClient struct {
	baseURL  string
	db       string
	user     string
	password string
	client   *http.Client
}

// NewCHClient builds a ClickHouse HTTP client.
func NewCHClient(baseURL, db, user, password string) *CHClient {
	return &CHClient{baseURL: baseURL, db: db, user: user, password: password, client: &http.Client{Timeout: 30 * time.Second}}
}

// scopeQuery maps a budget scope to its spend table + filter column.
func scopeQuery(scopeType string) (table, col, dateCol string) {
	switch scopeType {
	case "agent":
		return "spend_hourly_by_key", "agent_id", "toDate(hour)"
	case "key":
		return "spend_hourly_by_key", "virtual_key_id", "toDate(hour)"
	case "team":
		return "spend_daily", "team_id", "day"
	case "app":
		return "spend_daily", "app_id", "day"
	case "model":
		return "spend_daily", "model", "day"
	default: // tenant — no extra column filter
		return "spend_daily", "", "day"
	}
}

// ScopeSpend returns the budget scope's total cost since periodStart (a Date).
func (c *CHClient) ScopeSpend(ctx context.Context, b Budget, periodStart string) (float64, error) {
	table, col, dateCol := scopeQuery(b.ScopeType)
	params := map[string]string{"tenant": b.TenantID, "start": periodStart}
	filter := ""
	if col != "" {
		filter = fmt.Sprintf(" AND %s = {scope:String}", col)
		params["scope"] = b.ScopeID
	}
	sql := fmt.Sprintf(
		`SELECT sum(cost_usd) AS s FROM %s.%s WHERE tenant_id = {tenant:String} AND %s >= {start:Date}%s FORMAT JSONEachRow`,
		c.db, table, dateCol, filter)

	body, err := c.query(ctx, sql, params)
	if err != nil {
		return 0, err
	}
	var row struct {
		S float64 `json:"s"`
	}
	for _, line := range bytes.Split(bytes.TrimSpace(body), []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		if err := json.Unmarshal(line, &row); err != nil {
			return 0, fmt.Errorf("decode spend: %w", err)
		}
	}
	return row.S, nil
}

// HighRiskEvents returns severity=high risk events detected after `since`.
func (c *CHClient) HighRiskEvents(ctx context.Context, since string) ([]RiskEvent, error) {
	sql := fmt.Sprintf(
		`SELECT event_id, tenant_id, agent_id, category, severity, detail, toString(detected_at) AS detected_at
		 FROM %s.risk_events FINAL
		 WHERE severity = 'high' AND detected_at > parseDateTimeBestEffort({since:String})
		 ORDER BY detected_at FORMAT JSONEachRow`, c.db)
	body, err := c.query(ctx, sql, map[string]string{"since": since})
	if err != nil {
		return nil, err
	}
	var out []RiskEvent
	for _, line := range bytes.Split(bytes.TrimSpace(body), []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var e RiskEvent
		if err := json.Unmarshal(line, &e); err != nil {
			return nil, fmt.Errorf("decode risk event: %w", err)
		}
		out = append(out, e)
	}
	return out, nil
}

func (c *CHClient) query(ctx context.Context, sql string, params map[string]string) ([]byte, error) {
	q := url.Values{}
	q.Set("database", c.db)
	for k, v := range params {
		q.Set("param_"+k, v)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/?"+q.Encode(), bytes.NewReader([]byte(sql)))
	if err != nil {
		return nil, err
	}
	c.auth(req)
	resp, err := c.client.Do(req)
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

// Ping reports ClickHouse reachability for readiness checks.
func (c *CHClient) Ping(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/ping", nil)
	if err != nil {
		return err
	}
	resp, err := c.client.Do(req)
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

func (c *CHClient) auth(req *http.Request) {
	if c.user != "" {
		req.Header.Set("X-ClickHouse-User", c.user)
	}
	if c.password != "" {
		req.Header.Set("X-ClickHouse-Key", c.password)
	}
}
