package connector

import (
	"bytes"
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

// AnthropicConnector imports org-billed cost from the Anthropic Admin Cost
// Report API (GET /v1/organizations/cost_report), bucketed by day and grouped
// by model. It requires an org Admin API key and uses Anthropic's header auth
// (x-api-key + anthropic-version) rather than Bearer.
//
// Cursor shape: {"starting_at": "<RFC3339>", "page": "<token>"}. starting_at is
// the incremental watermark; page carries Anthropic's pagination token. On
// completion the watermark advances to the latest day seen so the still-accruing
// current day re-imports next run (ReplacingMergeTree keeps the latest).
type AnthropicConnector struct {
	client *http.Client
	now    func() time.Time
}

// NewAnthropicConnector constructs an AnthropicConnector with a default HTTP client.
func NewAnthropicConnector() *AnthropicConnector {
	return &AnthropicConnector{
		client: &http.Client{Timeout: 30 * time.Second},
		now:    time.Now,
	}
}

// Kind returns the connector's stable identifier.
func (c *AnthropicConnector) Kind() string { return "anthropic_usage" }

// flexFloat parses a JSON value that may be a number or a numeric string
// (Anthropic returns monetary amounts as strings, e.g. "12.50").
type flexFloat float64

func (f *flexFloat) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		*f = 0
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		if s == "" {
			*f = 0
			return nil
		}
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return err
		}
		*f = flexFloat(v)
		return nil
	}
	var v float64
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*f = flexFloat(v)
	return nil
}

type anthropicCostResponse struct {
	Data []struct {
		StartingAt string `json:"starting_at"`
		Results    []struct {
			Amount      flexFloat `json:"amount"`
			Currency    string    `json:"currency"`
			Model       string    `json:"model"`
			CostType    string    `json:"cost_type"`
			Description string    `json:"description"`
		} `json:"results"`
	} `json:"data"`
	HasMore  bool   `json:"has_more"`
	NextPage string `json:"next_page"`
}

// Fetch imports one page of org-billed cost records for the given cursor.
func (c *AnthropicConnector) Fetch(ctx context.Context, cfg map[string]any, cur Cursor) (Page, error) {
	baseURL := cfgString(cfg, "base_url", "https://api.anthropic.com")
	keyEnv := cfgString(cfg, "api_key_env", "ANTHROPIC_ADMIN_KEY")
	apiKey := os.Getenv(keyEnv)
	if apiKey == "" {
		return Page{}, fmt.Errorf("anthropic: env %s is empty (admin key required)", keyEnv)
	}
	version := cfgString(cfg, "anthropic_version", "2023-06-01")
	lookbackDays := cfgInt(cfg, "lookback_days", 30)
	pageSize := cfgInt(cfg, "page_size", 7)

	startISO := time.Unix(startOfUTCDay(c.now().AddDate(0, 0, -lookbackDays)), 0).UTC().Format(time.RFC3339)
	if v, ok := cur.Value["starting_at"].(string); ok && v != "" {
		startISO = v
	}
	page, _ := cur.Value["page"].(string)

	q := url.Values{}
	q.Set("starting_at", startISO)
	q.Set("bucket_width", "1d")
	q.Set("limit", strconv.Itoa(pageSize))
	q.Add("group_by", "description")
	if page != "" {
		q.Set("page", page)
	}

	endpoint := strings.TrimRight(baseURL, "/") + "/v1/organizations/cost_report?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Page{}, err
	}
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", version)

	resp, err := c.client.Do(req)
	if err != nil {
		return Page{}, fmt.Errorf("anthropic cost_report request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return Page{}, fmt.Errorf("anthropic cost_report status %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}

	var body anthropicCostResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return Page{}, fmt.Errorf("anthropic cost_report decode: %w", err)
	}

	var records []Record
	latestISO := startISO
	for _, bucket := range body.Data {
		if t, ok := parseRFC3339(bucket.StartingAt); ok {
			if lt, ok2 := parseRFC3339(latestISO); !ok2 || t.After(lt) {
				latestISO = bucket.StartingAt
			}
		}
		day := dayOf(bucket.StartingAt)
		for _, r := range bucket.Results {
			model := r.Model
			if model == "" {
				model = r.CostType
			}
			lineItem := r.CostType
			if lineItem == "" {
				lineItem = r.Description
			}
			currency := strings.ToUpper(r.Currency)
			if currency == "" {
				currency = "USD"
			}
			records = append(records, Record{
				Day:      day,
				Provider: "anthropic",
				Model:    model,
				LineItem: lineItem,
				CostUSD:  float64(r.Amount),
				Currency: currency,
			})
		}
	}

	if body.HasMore {
		return Page{
			Records: records,
			Next:    Cursor{Value: map[string]any{"starting_at": startISO, "page": body.NextPage}},
			Done:    false,
		}, nil
	}
	return Page{
		Records: records,
		Next:    Cursor{Value: map[string]any{"starting_at": latestISO}},
		Done:    true,
	}, nil
}

func parseRFC3339(s string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339, s)
	return t, err == nil
}

// dayOf returns the YYYY-MM-DD of an RFC3339 timestamp, falling back to its
// first 10 characters if it cannot be parsed.
func dayOf(s string) string {
	if t, ok := parseRFC3339(s); ok {
		return t.UTC().Format("2006-01-02")
	}
	if len(s) >= 10 {
		return s[:10]
	}
	return s
}
