package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// OpenAIConnector imports organization-level billed cost from the OpenAI Costs
// API (GET /v1/organization/costs), bucketed by day and grouped by line item +
// project. It requires an org Admin API key.
//
// Cursor shape: {"start_time": <unix seconds>, "page": "<token>"}. start_time is
// the incremental watermark (start of the earliest day still to import); page
// carries OpenAI's pagination token mid-fetch. On completion the watermark
// advances to the latest day seen, so the last (still-accruing) day is
// re-imported next run — the provider_costs ReplacingMergeTree keeps the latest.
type OpenAIConnector struct {
	client *http.Client
	now    func() time.Time
}

func NewOpenAIConnector() *OpenAIConnector {
	return &OpenAIConnector{
		client: &http.Client{Timeout: 30 * time.Second},
		now:    time.Now,
	}
}

func (c *OpenAIConnector) Kind() string { return "openai_usage" }

type openAICostsResponse struct {
	Data []struct {
		StartTime int64 `json:"start_time"`
		EndTime   int64 `json:"end_time"`
		Results   []struct {
			Amount struct {
				Value    float64 `json:"value"`
				Currency string  `json:"currency"`
			} `json:"amount"`
			LineItem  string `json:"line_item"`
			ProjectID string `json:"project_id"`
		} `json:"results"`
	} `json:"data"`
	HasMore  bool   `json:"has_more"`
	NextPage string `json:"next_page"`
}

func (c *OpenAIConnector) Fetch(ctx context.Context, cfg map[string]any, cur Cursor) (Page, error) {
	baseURL := cfgString(cfg, "base_url", "https://api.openai.com")
	keyEnv := cfgString(cfg, "api_key_env", "OPENAI_ADMIN_KEY")
	apiKey := os.Getenv(keyEnv)
	if apiKey == "" {
		return Page{}, fmt.Errorf("openai: env %s is empty (admin key required)", keyEnv)
	}
	lookbackDays := cfgInt(cfg, "lookback_days", 30)
	pageSize := cfgInt(cfg, "page_size", 7)

	// Resolve the start watermark and any in-flight pagination token.
	start := startOfUTCDay(c.now().AddDate(0, 0, -lookbackDays))
	if v, ok := cur.Value["start_time"].(float64); ok && v > 0 {
		start = int64(v)
	}
	page, _ := cur.Value["page"].(string)

	q := url.Values{}
	q.Set("start_time", strconv.FormatInt(start, 10))
	q.Set("bucket_width", "1d")
	q.Set("limit", strconv.Itoa(pageSize))
	q.Add("group_by", "line_item")
	q.Add("group_by", "project_id")
	if page != "" {
		q.Set("page", page)
	}

	endpoint := strings.TrimRight(baseURL, "/") + "/v1/organization/costs?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Page{}, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := c.client.Do(req)
	if err != nil {
		return Page{}, fmt.Errorf("openai costs request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return Page{}, fmt.Errorf("openai costs status %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}

	var body openAICostsResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return Page{}, fmt.Errorf("openai costs decode: %w", err)
	}

	var records []Record
	maxStart := start
	for _, bucket := range body.Data {
		if bucket.StartTime > maxStart {
			maxStart = bucket.StartTime
		}
		day := time.Unix(bucket.StartTime, 0).UTC().Format("2006-01-02")
		for _, r := range bucket.Results {
			records = append(records, Record{
				Day:          day,
				Provider:     "openai",
				Model:        parseOpenAIModel(r.LineItem),
				LineItem:     r.LineItem,
				VirtualKeyID: r.ProjectID,
				CostUSD:      r.Amount.Value,
				Currency:     strings.ToUpper(r.Amount.Currency),
			})
		}
	}

	if body.HasMore {
		// More pages for the same window: keep the watermark, carry the token.
		return Page{
			Records: records,
			Next:    Cursor{Value: map[string]any{"start_time": float64(start), "page": body.NextPage}},
			Done:    false,
		}, nil
	}
	// Window complete: advance the watermark to the latest day seen so the next
	// run re-imports that (possibly still-accruing) day and moves forward.
	return Page{
		Records: records,
		Next:    Cursor{Value: map[string]any{"start_time": float64(maxStart)}},
		Done:    true,
	}, nil
}

// parseOpenAIModel pulls the model from a costs line item such as
// "gpt-4o-2024-08-06, input" → "gpt-4o-2024-08-06".
func parseOpenAIModel(lineItem string) string {
	if i := strings.IndexByte(lineItem, ','); i >= 0 {
		return strings.TrimSpace(lineItem[:i])
	}
	return strings.TrimSpace(lineItem)
}

func startOfUTCDay(t time.Time) int64 {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix()
}

func cfgString(cfg map[string]any, key, def string) string {
	if v, ok := cfg[key].(string); ok && v != "" {
		return v
	}
	return def
}

func cfgInt(cfg map[string]any, key string, def int) int {
	switch v := cfg[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
