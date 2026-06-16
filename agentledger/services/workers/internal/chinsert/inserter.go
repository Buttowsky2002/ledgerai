package chinsert

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Inserter writes a batch of JSON event rows into a ClickHouse table.
type Inserter interface {
	Insert(ctx context.Context, table string, rows [][]byte) error
}

// HTTPInserter inserts via the ClickHouse HTTP interface using FORMAT
// JSONEachRow. The raw event JSON is posted verbatim — ClickHouse maps JSON
// keys to columns, skips unknown keys, and applies column defaults for missing
// ones. This keeps the worker dependency-free (stdlib net/http; no CH client).
type HTTPInserter struct {
	baseURL  string
	db       string
	user     string
	password string
	client   *http.Client
}

func NewHTTPInserter(baseURL, db, user, password string) *HTTPInserter {
	return &HTTPInserter{
		baseURL:  baseURL,
		db:       db,
		user:     user,
		password: password,
		client:   &http.Client{Timeout: 30 * time.Second},
	}
}

func (h *HTTPInserter) Insert(ctx context.Context, table string, rows [][]byte) error {
	if !isKnownTable(table) {
		return fmt.Errorf("refusing insert into unknown table %q", table)
	}
	if len(rows) == 0 {
		return nil
	}

	var body bytes.Buffer
	for _, r := range rows {
		body.Write(r)
		body.WriteByte('\n')
	}

	q := url.Values{}
	// Table comes from the fixed allowlist (isKnownTable), never user input.
	q.Set("query", fmt.Sprintf("INSERT INTO %s.%s FORMAT JSONEachRow", h.db, table))
	q.Set("input_format_skip_unknown_fields", "1") // tolerate kind/source/extra keys
	q.Set("date_time_input_format", "best_effort") // parse ISO-8601 ts with Z
	endpoint := h.baseURL + "/?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return fmt.Errorf("build insert request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	if h.user != "" {
		req.Header.Set("X-ClickHouse-User", h.user)
	}
	if h.password != "" {
		req.Header.Set("X-ClickHouse-Key", h.password)
	}

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
func (h *HTTPInserter) Ping(ctx context.Context) error {
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
