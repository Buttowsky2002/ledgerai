package connector

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"
)

// ZendeskConnector imports solved Zendesk tickets as business outcomes
// (outcome_type "ticket_resolved"). It queries the Zendesk Search API for solved
// tickets sorted by update time (descending) using stdlib HTTP only — no SDK
// dependency, mirroring the GitHub importer.
//
// Config (connectors.config JSON):
//
//	base_url      "https://org.zendesk.com" (required)
//	email_env     env var holding the account email (required; rule 1 — name, not value)
//	token_env     env var holding the API token   (required; rule 1 — name, not value)
//	lookback_days number (default 30)             trailing window re-scanned each pass
//
// Auth is HTTP Basic base64(email:token) (ADR-017). NOTE: Zendesk's API-token
// form technically expects the username "email/token"; we keep the uniform
// email:token model agreed for these connectors (works with password/OAuth-token
// Basic auth) — see ADR-017. The cursor carries the in-pass page number; on
// completion it resets to empty so the next pass re-scans the lookback window. A
// stable outcome_id ("zendesk:ID") + the outcomes ReplacingMergeTree make the
// re-scan idempotent.
type ZendeskConnector struct {
	client *http.Client
	now    func() time.Time
}

// NewZendeskConnector constructs a ZendeskConnector with a default HTTP client.
func NewZendeskConnector() *ZendeskConnector {
	return &ZendeskConnector{client: &http.Client{Timeout: 30 * time.Second}, now: time.Now}
}

// Kind returns the connector's stable identifier.
func (c *ZendeskConnector) Kind() string { return "zendesk" }

type zdSearch struct {
	Results []struct {
		ID         int    `json:"id"`
		Status     string `json:"status"`
		UpdatedAt  string `json:"updated_at"`
		AssigneeID *int   `json:"assignee_id"`
	} `json:"results"`
	NextPage *string `json:"next_page"`
	Count    int     `json:"count"`
}

// Fetch imports one page of resolved tickets for the given cursor.
func (c *ZendeskConnector) Fetch(ctx context.Context, cfg map[string]any, cur Cursor) (OutcomePage, error) {
	baseURL, _ := cfg["base_url"].(string)
	emailEnv, _ := cfg["email_env"].(string)
	tokenEnv, _ := cfg["token_env"].(string)
	if baseURL == "" || emailEnv == "" || tokenEnv == "" {
		return OutcomePage{}, fmt.Errorf("zendesk connector requires config.base_url, config.email_env and config.token_env")
	}
	email := os.Getenv(emailEnv)
	token := os.Getenv(tokenEnv)
	if email == "" || token == "" {
		return OutcomePage{}, fmt.Errorf("zendesk email env %q / token env %q must be set", emailEnv, tokenEnv)
	}
	lookback := 30
	if v, ok := cfg["lookback_days"].(float64); ok && v > 0 {
		lookback = int(v)
	}
	floor := c.now().UTC().AddDate(0, 0, -lookback)

	page := 1
	if v, ok := cur.Value["page"].(float64); ok && int(v) > 0 {
		page = int(v)
	}

	query := fmt.Sprintf("type:ticket status:solved updated>%s", floor.Format("2006-01-02"))
	q := url.Values{}
	q.Set("query", query)
	q.Set("sort_by", "updated_at")
	q.Set("sort_order", "desc")
	q.Set("per_page", "100")
	q.Set("page", strconv.Itoa(page))
	endpoint := fmt.Sprintf("%s/api/v2/search.json?%s", baseURL, q.Encode())

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return OutcomePage{}, err
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(email+":"+token)))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "agentledger-connectors")

	resp, err := c.client.Do(req)
	if err != nil {
		return OutcomePage{}, fmt.Errorf("zendesk request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return OutcomePage{}, fmt.Errorf("zendesk status %d: %s", resp.StatusCode, msg)
	}

	var search zdSearch
	if err := json.NewDecoder(resp.Body).Decode(&search); err != nil {
		return OutcomePage{}, fmt.Errorf("decode tickets: %w", err)
	}

	var records []OutcomeRecord
	for _, t := range search.Results {
		updated, err := time.Parse(time.RFC3339, t.UpdatedAt)
		if err != nil || updated.Before(floor) {
			continue
		}
		userID := ""
		if t.AssigneeID != nil {
			userID = strconv.Itoa(*t.AssigneeID)
		}
		records = append(records, OutcomeRecord{
			OutcomeID:        fmt.Sprintf("zendesk:%d", t.ID),
			TS:               updated.UTC().Format("2006-01-02 15:04:05.000"),
			SourceSystem:     "zendesk",
			OutcomeType:      "ticket_resolved",
			UserID:           userID,
			CompletionStatus: t.Status,
			// run_id / attribution_confidence / business_value_usd intentionally
			// zero — filled by the attribution matcher (task 3) and ROI templates.
		})
	}

	done := search.NextPage == nil || len(search.Results) < 100
	next := Cursor{Value: map[string]any{"page": float64(page + 1)}}
	if done {
		next = Cursor{} // reset → next pass re-scans the lookback window
	}
	return OutcomePage{Records: records, Next: next, Done: done}, nil
}
