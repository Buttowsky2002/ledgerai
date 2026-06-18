package connector

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Fixture: 3 issues sorted by updated desc — one resolved in-window, one
// unresolved (resolutiondate null), one resolved but updated before the floor.
const jiraSearchFixture = `{
  "startAt": 0,
  "maxResults": 100,
  "total": 3,
  "issues": [
    {"key":"PROJ-12","fields":{"resolutiondate":"2026-06-10T12:00:00.000+0000","updated":"2026-06-10T12:00:00.000+0000","assignee":{"accountId":"acc-1"},"status":{"name":"Done"}}},
    {"key":"PROJ-11","fields":{"resolutiondate":null,"updated":"2026-06-05T09:00:00.000+0000","assignee":{"accountId":"acc-2"},"status":{"name":"In Progress"}}},
    {"key":"PROJ-10","fields":{"resolutiondate":"2026-01-01T00:00:00.000+0000","updated":"2026-01-01T00:00:00.000+0000","assignee":null,"status":{"name":"Done"}}}
  ]
}`

func TestJiraFetchResolvedIssues(t *testing.T) {
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("alice@acme.com:tok_test"))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != wantAuth {
			t.Errorf("missing/wrong auth header: %q", got)
		}
		if r.URL.Path != "/rest/api/3/search" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(jiraSearchFixture))
	}))
	defer srv.Close()

	t.Setenv("JIRA_EMAIL", "alice@acme.com")
	t.Setenv("JIRA_TOKEN", "tok_test")
	c := NewJiraConnector()
	c.now = func() time.Time { return time.Date(2026, 6, 17, 0, 0, 0, 0, time.UTC) } // floor = 2026-05-18

	pg, err := c.Fetch(context.Background(), map[string]any{
		"base_url":  srv.URL,
		"email_env": "JIRA_EMAIL",
		"token_env": "JIRA_TOKEN",
		"project":   "PROJ",
	}, Cursor{})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}

	if len(pg.Records) != 1 {
		t.Fatalf("want 1 resolved in-window issue, got %d", len(pg.Records))
	}
	r := pg.Records[0]
	if r.OutcomeID != "jira:PROJ-12" {
		t.Errorf("outcome_id = %q", r.OutcomeID)
	}
	if r.OutcomeType != "issue_closed" || r.SourceSystem != "jira" {
		t.Errorf("type/source = %q/%q", r.OutcomeType, r.SourceSystem)
	}
	if r.UserID != "acc-1" {
		t.Errorf("user_id = %q", r.UserID)
	}
	if r.TS != "2026-06-10 12:00:00.000" {
		t.Errorf("ts = %q", r.TS)
	}
	if r.CompletionStatus != "Done" {
		t.Errorf("completion_status = %q", r.CompletionStatus)
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

func TestJiraMissingConfig(t *testing.T) {
	c := NewJiraConnector()
	if _, err := c.Fetch(context.Background(), map[string]any{"base_url": "https://x.atlassian.net"}, Cursor{}); err == nil {
		t.Fatal("want error when email_env/token_env/project are missing")
	}
}

func TestJiraStableOutcomeIDForReplay(t *testing.T) {
	// Same issue fetched twice yields the same outcome_id → ReplacingMergeTree dedups.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(jiraSearchFixture))
	}))
	defer srv.Close()
	t.Setenv("JIRA_EMAIL", "alice@acme.com")
	t.Setenv("JIRA_TOKEN", "tok_test")
	c := NewJiraConnector()
	c.now = func() time.Time { return time.Date(2026, 6, 17, 0, 0, 0, 0, time.UTC) }
	cfg := map[string]any{"base_url": srv.URL, "email_env": "JIRA_EMAIL", "token_env": "JIRA_TOKEN", "project": "PROJ"}

	a, _ := c.Fetch(context.Background(), cfg, Cursor{})
	b, _ := c.Fetch(context.Background(), cfg, Cursor{})
	if len(a.Records) != 1 || len(b.Records) != 1 || a.Records[0].OutcomeID != b.Records[0].OutcomeID {
		t.Fatalf("outcome_id not stable across fetches")
	}
}
