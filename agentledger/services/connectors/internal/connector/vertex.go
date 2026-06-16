package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// VertexConnector imports GCP Vertex AI spend from the BigQuery Cloud Billing
// export, via the BigQuery jobs.query REST API. Actual GCP spend is only
// available through the billing export (the Cloud Billing API exposes pricing,
// not spend), so the connector queries the export table grouped by day + SKU.
//
// Auth is an OAuth2 bearer token read from the env var named in config (supplied
// by workload identity / `gcloud auth print-access-token` out of band). The date
// filter is a NAMED query parameter — never string-concatenated (rule 4); the
// table name comes from operator config and is format-validated.
//
// Cursor shape: {"start": "YYYY-MM-DD"}. The window is [start, today]; on
// completion the watermark advances to today so the still-accruing day
// re-imports next run (provider_costs ReplacingMergeTree keeps the latest).
type VertexConnector struct {
	client *http.Client
	now    func() time.Time
}

func NewVertexConnector() *VertexConnector {
	return &VertexConnector{
		client: &http.Client{Timeout: 60 * time.Second},
		now:    time.Now,
	}
}

func (c *VertexConnector) Kind() string { return "vertex" }

var bqTablePattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]+$`)

type bqQueryResponse struct {
	JobComplete bool `json:"jobComplete"`
	Rows        []struct {
		F []struct {
			V json.RawMessage `json:"v"`
		} `json:"f"`
	} `json:"rows"`
	PageToken string `json:"pageToken"`
}

func (c *VertexConnector) Fetch(ctx context.Context, cfg map[string]any, cur Cursor) (Page, error) {
	baseURL := cfgString(cfg, "base_url", "https://bigquery.googleapis.com")
	project := cfgString(cfg, "project_id", "")
	table := cfgString(cfg, "billing_table", "")
	if project == "" || table == "" {
		return Page{}, fmt.Errorf("vertex: project_id and billing_table are required in connector config")
	}
	if !bqTablePattern.MatchString(table) {
		return Page{}, fmt.Errorf("vertex: billing_table %q has an unsafe format", table)
	}
	token := os.Getenv(cfgString(cfg, "token_env", "GCP_ACCESS_TOKEN"))
	if token == "" {
		return Page{}, fmt.Errorf("vertex: bearer token env is empty")
	}
	serviceMatch := cfgString(cfg, "service_filter", "Vertex")
	lookbackDays := cfgInt(cfg, "lookback_days", 30)

	start := c.now().UTC().AddDate(0, 0, -lookbackDays).Format("2006-01-02")
	if v, ok := cur.Value["start"].(string); ok && v != "" {
		start = v
	}

	// Table is format-validated; the date and service filter are bound as NAMED
	// parameters, so no untrusted value is concatenated into SQL.
	query := "SELECT FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time)) AS day, " +
		"COALESCE(sku.description, '') AS sku, " +
		"SUM(cost) AS cost, ANY_VALUE(currency) AS currency " +
		"FROM `" + table + "` " +
		"WHERE service.description LIKE CONCAT('%', @svc, '%') " +
		"AND DATE(usage_start_time) >= @start " +
		"GROUP BY day, sku ORDER BY day"

	reqBody := map[string]any{
		"query":         query,
		"useLegacySql":  false,
		"parameterMode": "NAMED",
		"maxResults":    100000,
		"queryParameters": []map[string]any{
			{"name": "start", "parameterType": map[string]string{"type": "STRING"}, "parameterValue": map[string]string{"value": start}},
			{"name": "svc", "parameterType": map[string]string{"type": "STRING"}, "parameterValue": map[string]string{"value": serviceMatch}},
		},
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return Page{}, err
	}

	endpoint := strings.TrimRight(baseURL, "/") + "/bigquery/v2/projects/" + project + "/queries"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return Page{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return Page{}, fmt.Errorf("bigquery request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return Page{}, fmt.Errorf("bigquery status %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}

	var body bqQueryResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return Page{}, fmt.Errorf("bigquery decode: %w", err)
	}

	var records []Record
	maxStart := start
	for _, row := range body.Rows {
		if len(row.F) < 4 {
			continue
		}
		day := cellString(row.F[0].V)
		sku := cellString(row.F[1].V)
		cost, _ := strconv.ParseFloat(cellString(row.F[2].V), 64)
		currency := strings.ToUpper(cellString(row.F[3].V))
		if currency == "" {
			currency = "USD"
		}
		if day > maxStart {
			maxStart = day
		}
		records = append(records, Record{
			Day:      day,
			Provider: "gcp_vertex",
			Model:    sku, // GCP attributes spend by SKU, not model id
			LineItem: sku,
			CostUSD:  cost,
			Currency: currency,
		})
	}

	// jobs.query returns at most maxResults rows; grouped daily Vertex spend
	// fits comfortably. (Paging via getQueryResults is a future enhancement.)
	return Page{
		Records: records,
		Next:    Cursor{Value: map[string]any{"start": maxStart}},
		Done:    true,
	}, nil
}

// cellString decodes a BigQuery cell value (always a JSON string or null).
func cellString(v json.RawMessage) string {
	var s string
	if err := json.Unmarshal(v, &s); err == nil {
		return s
	}
	return ""
}
