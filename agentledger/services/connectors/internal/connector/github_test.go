package connector

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Fixture: 3 closed PRs sorted by updated desc — one merged in-window, one closed
// (not merged), one merged but updated before the lookback floor.
const ghPullsFixture = `[
  {"number":42,"title":"feat","merged_at":"2026-06-10T12:00:00Z","updated_at":"2026-06-10T12:00:00Z","user":{"login":"alice"}},
  {"number":41,"title":"wip","merged_at":null,"updated_at":"2026-06-05T09:00:00Z","user":{"login":"bob"}},
  {"number":40,"title":"old","merged_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","user":{"login":"carol"}}
]`

func TestGitHubFetchMergedPRs(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer ghp_test" {
			t.Errorf("missing/wrong auth header: %q", got)
		}
		if r.URL.Path != "/repos/acme/web/pulls" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(ghPullsFixture))
	}))
	defer srv.Close()

	t.Setenv("GH_TOKEN", "ghp_test")
	c := NewGitHubConnector()
	c.now = func() time.Time { return time.Date(2026, 6, 17, 0, 0, 0, 0, time.UTC) } // floor = 2026-05-18

	pg, err := c.Fetch(context.Background(), map[string]any{
		"repo":      "acme/web",
		"token_env": "GH_TOKEN",
		"base_url":  srv.URL,
	}, Cursor{})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}

	if len(pg.Records) != 1 {
		t.Fatalf("want 1 merged in-window PR, got %d", len(pg.Records))
	}
	r := pg.Records[0]
	if r.OutcomeID != "github:acme/web#42" {
		t.Errorf("outcome_id = %q", r.OutcomeID)
	}
	if r.OutcomeType != "pr_merged" || r.SourceSystem != "github" {
		t.Errorf("type/source = %q/%q", r.OutcomeType, r.SourceSystem)
	}
	if r.UserID != "alice" {
		t.Errorf("user_id = %q", r.UserID)
	}
	if r.TS != "2026-06-10 12:00:00.000" {
		t.Errorf("ts = %q", r.TS)
	}
	if r.AttributionConfidence != 0 || r.RunID != "" {
		t.Errorf("confidence/run_id should be unset for the matcher to fill")
	}
	if !pg.Done {
		t.Errorf("want Done (short page / reached floor)")
	}
	if !pg.Next.IsZero() {
		t.Errorf("cursor should reset on Done, got %v", pg.Next.Value)
	}
}

func TestGitHubMissingConfig(t *testing.T) {
	c := NewGitHubConnector()
	if _, err := c.Fetch(context.Background(), map[string]any{"repo": "acme/web"}, Cursor{}); err == nil {
		t.Fatal("want error when token_env is missing")
	}
}

func TestGitHubStableOutcomeIDForReplay(t *testing.T) {
	// Same PR fetched twice yields the same outcome_id → ReplacingMergeTree dedups.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(ghPullsFixture))
	}))
	defer srv.Close()
	t.Setenv("GH_TOKEN", "ghp_test")
	c := NewGitHubConnector()
	c.now = func() time.Time { return time.Date(2026, 6, 17, 0, 0, 0, 0, time.UTC) }
	cfg := map[string]any{"repo": "acme/web", "token_env": "GH_TOKEN", "base_url": srv.URL}

	a, _ := c.Fetch(context.Background(), cfg, Cursor{})
	b, _ := c.Fetch(context.Background(), cfg, Cursor{})
	if len(a.Records) != 1 || len(b.Records) != 1 || a.Records[0].OutcomeID != b.Records[0].OutcomeID {
		t.Fatalf("outcome_id not stable across fetches")
	}
}
