package connector

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Fixture: 2 solved tickets sorted by updated desc — one in-window, one updated
// before the lookback floor (must be filtered out). next_page null → Done.
const zdSearchFixture = `{
  "results": [
    {"id":42,"status":"solved","updated_at":"2026-06-10T12:00:00Z","assignee_id":7},
    {"id":40,"status":"solved","updated_at":"2026-01-01T00:00:00Z","assignee_id":null}
  ],
  "next_page": null,
  "count": 2
}`

func TestZendeskFetchSolvedTickets(t *testing.T) {
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("alice@acme.com:tok_test"))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != wantAuth {
			t.Errorf("missing/wrong auth header: %q", got)
		}
		if r.URL.Path != "/api/v2/search.json" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(zdSearchFixture))
	}))
	defer srv.Close()

	t.Setenv("ZD_EMAIL", "alice@acme.com")
	t.Setenv("ZD_TOKEN", "tok_test")
	c := NewZendeskConnector()
	c.now = func() time.Time { return time.Date(2026, 6, 17, 0, 0, 0, 0, time.UTC) } // floor = 2026-05-18

	pg, err := c.Fetch(context.Background(), map[string]any{
		"base_url":  srv.URL,
		"email_env": "ZD_EMAIL",
		"token_env": "ZD_TOKEN",
	}, Cursor{})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}

	if len(pg.Records) != 1 {
		t.Fatalf("want 1 solved in-window ticket, got %d", len(pg.Records))
	}
	r := pg.Records[0]
	if r.OutcomeID != "zendesk:42" {
		t.Errorf("outcome_id = %q", r.OutcomeID)
	}
	if r.OutcomeType != "ticket_resolved" || r.SourceSystem != "zendesk" {
		t.Errorf("type/source = %q/%q", r.OutcomeType, r.SourceSystem)
	}
	if r.UserID != "7" {
		t.Errorf("user_id = %q", r.UserID)
	}
	if r.TS != "2026-06-10 12:00:00.000" {
		t.Errorf("ts = %q", r.TS)
	}
	if r.CompletionStatus != "solved" {
		t.Errorf("completion_status = %q", r.CompletionStatus)
	}
	if r.AttributionConfidence != 0 || r.RunID != "" {
		t.Errorf("confidence/run_id should be unset for the matcher to fill")
	}
	if !pg.Done {
		t.Errorf("want Done (next_page null / short page)")
	}
	if !pg.Next.IsZero() {
		t.Errorf("cursor should reset on Done, got %v", pg.Next.Value)
	}
}

func TestZendeskMissingConfig(t *testing.T) {
	c := NewZendeskConnector()
	if _, err := c.Fetch(context.Background(), map[string]any{"base_url": "https://x.zendesk.com"}, Cursor{}); err == nil {
		t.Fatal("want error when email_env/token_env are missing")
	}
}

func TestZendeskStableOutcomeIDForReplay(t *testing.T) {
	// Same ticket fetched twice yields the same outcome_id → ReplacingMergeTree dedups.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(zdSearchFixture))
	}))
	defer srv.Close()
	t.Setenv("ZD_EMAIL", "alice@acme.com")
	t.Setenv("ZD_TOKEN", "tok_test")
	c := NewZendeskConnector()
	c.now = func() time.Time { return time.Date(2026, 6, 17, 0, 0, 0, 0, time.UTC) }
	cfg := map[string]any{"base_url": srv.URL, "email_env": "ZD_EMAIL", "token_env": "ZD_TOKEN"}

	a, _ := c.Fetch(context.Background(), cfg, Cursor{})
	b, _ := c.Fetch(context.Background(), cfg, Cursor{})
	if len(a.Records) != 1 || len(b.Records) != 1 || a.Records[0].OutcomeID != b.Records[0].OutcomeID {
		t.Fatalf("outcome_id not stable across fetches")
	}
}
