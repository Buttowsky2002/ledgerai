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

// JiraConnector imports resolved Jira issues as business outcomes
// (outcome_type "issue_closed"). It pulls Done-category issues sorted by update
// time (descending) from the Jira Cloud REST API using stdlib HTTP only — no SDK
// dependency, mirroring the GitHub importer.
//
// Config (connectors.config JSON):
//
//	base_url      "https://org.atlassian.net" (required)
//	email_env     env var holding the account email (required; rule 1 — name, not value)
//	token_env     env var holding the API token   (required; rule 1 — name, not value)
//	project       Jira project key, e.g. "OPS"    (required)
//	lookback_days number (default 30)             trailing window re-scanned each pass
//
// Jira Cloud authenticates with HTTP Basic base64(email:token) (ADR-017). The
// cursor carries the in-pass startAt offset; on completion it resets to empty so
// the next pass re-scans the lookback window. A stable outcome_id ("jira:KEY") +
// the outcomes ReplacingMergeTree make the re-scan idempotent.
type JiraConnector struct {
	client *http.Client
	now    func() time.Time
}

// NewJiraConnector constructs a JiraConnector with a default HTTP client.
func NewJiraConnector() *JiraConnector {
	return &JiraConnector{client: &http.Client{Timeout: 30 * time.Second}, now: time.Now}
}

// Kind returns the connector's stable identifier.
func (c *JiraConnector) Kind() string { return "jira" }

// jiraTime is the timestamp layout Jira returns (millis + numeric offset, e.g.
// 2026-06-10T12:00:00.000+0000).
const jiraTime = "2006-01-02T15:04:05.000-0700"

type jiraSearch struct {
	StartAt    int `json:"startAt"`
	MaxResults int `json:"maxResults"`
	Total      int `json:"total"`
	Issues     []struct {
		Key    string `json:"key"`
		Fields struct {
			ResolutionDate *string `json:"resolutiondate"`
			Updated        string  `json:"updated"`
			Assignee       *struct {
				AccountID string `json:"accountId"`
			} `json:"assignee"`
			Status struct {
				Name string `json:"name"`
			} `json:"status"`
		} `json:"fields"`
	} `json:"issues"`
}

// Fetch imports one page of resolved issues for the given cursor.
func (c *JiraConnector) Fetch(ctx context.Context, cfg map[string]any, cur Cursor) (OutcomePage, error) {
	baseURL, _ := cfg["base_url"].(string)
	emailEnv, _ := cfg["email_env"].(string)
	tokenEnv, _ := cfg["token_env"].(string)
	project, _ := cfg["project"].(string)
	if baseURL == "" || emailEnv == "" || tokenEnv == "" || project == "" {
		return OutcomePage{}, fmt.Errorf("jira connector requires config.base_url, config.email_env, config.token_env and config.project")
	}
	email := os.Getenv(emailEnv)
	token := os.Getenv(tokenEnv)
	if email == "" || token == "" {
		return OutcomePage{}, fmt.Errorf("jira email env %q / token env %q must be set", emailEnv, tokenEnv)
	}
	lookback := 30
	if v, ok := cfg["lookback_days"].(float64); ok && v > 0 {
		lookback = int(v)
	}
	floor := c.now().UTC().AddDate(0, 0, -lookback)

	startAt := 0
	if v, ok := cur.Value["start_at"].(float64); ok && int(v) > 0 {
		startAt = int(v)
	}

	jql := fmt.Sprintf(`project = %q AND statusCategory = Done AND updated >= "-%dd" ORDER BY updated DESC`, project, lookback)
	q := url.Values{}
	q.Set("jql", jql)
	q.Set("startAt", strconv.Itoa(startAt))
	q.Set("maxResults", "100")
	q.Set("fields", "resolutiondate,updated,assignee,status")
	endpoint := fmt.Sprintf("%s/rest/api/3/search?%s", baseURL, q.Encode())

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return OutcomePage{}, err
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(email+":"+token)))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "agentledger-connectors")

	resp, err := c.client.Do(req)
	if err != nil {
		return OutcomePage{}, fmt.Errorf("jira request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return OutcomePage{}, fmt.Errorf("jira status %d: %s", resp.StatusCode, msg)
	}

	var search jiraSearch
	if err := json.NewDecoder(resp.Body).Decode(&search); err != nil {
		return OutcomePage{}, fmt.Errorf("decode issues: %w", err)
	}

	var records []OutcomeRecord
	reachedFloor := false
	for _, iss := range search.Issues {
		updated, err := time.Parse(jiraTime, iss.Fields.Updated)
		if err == nil && updated.Before(floor) {
			// Sorted by updated desc: nothing older can be within the window.
			reachedFloor = true
			break
		}
		if iss.Fields.ResolutionDate == nil {
			continue // open / unresolved
		}
		resolved, err := time.Parse(jiraTime, *iss.Fields.ResolutionDate)
		if err != nil || resolved.Before(floor) {
			continue
		}
		userID := ""
		if iss.Fields.Assignee != nil {
			userID = iss.Fields.Assignee.AccountID
		}
		records = append(records, OutcomeRecord{
			OutcomeID:        "jira:" + iss.Key,
			TS:               resolved.UTC().Format("2006-01-02 15:04:05.000"),
			SourceSystem:     "jira",
			OutcomeType:      "issue_closed",
			UserID:           userID,
			CompletionStatus: iss.Fields.Status.Name,
			// run_id / attribution_confidence / business_value_usd intentionally
			// zero — filled by the attribution matcher (task 3) and ROI templates.
		})
	}

	done := reachedFloor || startAt+len(search.Issues) >= search.Total || len(search.Issues) < 100
	next := Cursor{Value: map[string]any{"start_at": float64(startAt + len(search.Issues))}}
	if done {
		next = Cursor{} // reset → next pass re-scans the lookback window
	}
	return OutcomePage{Records: records, Next: next, Done: done}, nil
}
