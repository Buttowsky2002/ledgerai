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
	"time"
)

// GitHubConnector imports merged pull requests as business outcomes
// (outcome_type "pr_merged"). It pulls closed PRs sorted by update time
// (descending) from the GitHub REST API using stdlib HTTP only — no SDK
// dependency, mirroring the Bedrock/Vertex importers.
//
// Config (connectors.config JSON):
//   repo          "owner/name"            (required)
//   token_env     env var holding a PAT   (required; rule 1 — name, not value)
//   lookback_days number (default 30)     trailing window re-scanned each pass
//   base_url      override (default https://api.github.com; for tests)
//
// Cursor carries the in-pass page number; on completion it resets to empty so the
// next pass re-scans the lookback window. Stable outcome_id + the outcomes
// ReplacingMergeTree make the re-scan idempotent.
type GitHubConnector struct {
	client *http.Client
	now    func() time.Time
}

func NewGitHubConnector() *GitHubConnector {
	return &GitHubConnector{client: &http.Client{Timeout: 30 * time.Second}, now: time.Now}
}

func (c *GitHubConnector) Kind() string { return "github" }

type ghPull struct {
	Number    int     `json:"number"`
	Title     string  `json:"title"`
	MergedAt  *string `json:"merged_at"`
	UpdatedAt string  `json:"updated_at"`
	User      struct {
		Login string `json:"login"`
	} `json:"user"`
}

func (c *GitHubConnector) Fetch(ctx context.Context, cfg map[string]any, cur Cursor) (OutcomePage, error) {
	repo, _ := cfg["repo"].(string)
	tokenEnv, _ := cfg["token_env"].(string)
	if repo == "" || tokenEnv == "" {
		return OutcomePage{}, fmt.Errorf("github connector requires config.repo and config.token_env")
	}
	token := os.Getenv(tokenEnv)
	if token == "" {
		return OutcomePage{}, fmt.Errorf("github token env %q is empty", tokenEnv)
	}
	baseURL, _ := cfg["base_url"].(string)
	if baseURL == "" {
		baseURL = "https://api.github.com"
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

	q := url.Values{}
	q.Set("state", "closed")
	q.Set("sort", "updated")
	q.Set("direction", "desc")
	q.Set("per_page", "100")
	q.Set("page", strconv.Itoa(page))
	endpoint := fmt.Sprintf("%s/repos/%s/pulls?%s", baseURL, repo, q.Encode())

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return OutcomePage{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "agentledger-connectors")

	resp, err := c.client.Do(req)
	if err != nil {
		return OutcomePage{}, fmt.Errorf("github request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return OutcomePage{}, fmt.Errorf("github status %d: %s", resp.StatusCode, msg)
	}

	var pulls []ghPull
	if err := json.NewDecoder(resp.Body).Decode(&pulls); err != nil {
		return OutcomePage{}, fmt.Errorf("decode pulls: %w", err)
	}

	var records []OutcomeRecord
	reachedFloor := false
	for _, p := range pulls {
		updated, err := time.Parse(time.RFC3339, p.UpdatedAt)
		if err == nil && updated.Before(floor) {
			// Sorted by updated desc: nothing older can be within the window.
			reachedFloor = true
			break
		}
		if p.MergedAt == nil {
			continue // closed-but-not-merged
		}
		merged, err := time.Parse(time.RFC3339, *p.MergedAt)
		if err != nil || merged.Before(floor) {
			continue
		}
		records = append(records, OutcomeRecord{
			OutcomeID:        fmt.Sprintf("github:%s#%d", repo, p.Number),
			TS:               merged.UTC().Format("2006-01-02 15:04:05.000"),
			SourceSystem:     "github",
			OutcomeType:      "pr_merged",
			UserID:           p.User.Login,
			CompletionStatus: "merged",
			// run_id / attribution_confidence / business_value_usd intentionally
			// zero — filled by the attribution matcher (task 3) and ROI templates.
		})
	}

	done := reachedFloor || len(pulls) < 100
	next := Cursor{Value: map[string]any{"page": float64(page + 1)}}
	if done {
		next = Cursor{} // reset → next pass re-scans the lookback window
	}
	return OutcomePage{Records: records, Next: next, Done: done}, nil
}
