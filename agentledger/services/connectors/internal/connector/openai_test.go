package connector

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestParseOpenAIModel(t *testing.T) {
	cases := map[string]string{
		"gpt-4o-2024-08-06, input": "gpt-4o-2024-08-06",
		"gpt-4o-mini, output":      "gpt-4o-mini",
		"text-embedding-3-large":   "text-embedding-3-large",
		"  o3, input ":             "o3",
	}
	for in, want := range cases {
		if got := parseOpenAIModel(in); got != want {
			t.Errorf("parseOpenAIModel(%q) = %q, want %q", in, got, want)
		}
	}
}

// fixedClock pins the connector's notion of "now" for deterministic watermarks.
func fixedClock() func() time.Time {
	return func() time.Time { return time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC) }
}

func TestOpenAIFetchSinglePage(t *testing.T) {
	day := time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC).Unix()
	var gotAuth, gotBucket string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotBucket = r.URL.Query().Get("bucket_width")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []any{map[string]any{
				"start_time": day, "end_time": day + 86400,
				"results": []any{
					map[string]any{"amount": map[string]any{"value": 12.5, "currency": "usd"}, "line_item": "gpt-4o-2024-08-06, input", "project_id": "proj_1"},
					map[string]any{"amount": map[string]any{"value": 3.0, "currency": "usd"}, "line_item": "gpt-4o-2024-08-06, output", "project_id": "proj_1"},
				},
			}},
			"has_more": false, "next_page": "",
		})
	}))
	defer srv.Close()

	_ = os.Setenv("OPENAI_ADMIN_KEY_TEST", "sk-admin-xxx")
	c := NewOpenAIConnector()
	c.now = fixedClock()
	cfg := map[string]any{"base_url": srv.URL, "api_key_env": "OPENAI_ADMIN_KEY_TEST"}

	pg, err := c.Fetch(context.Background(), cfg, Cursor{})
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer sk-admin-xxx" {
		t.Fatalf("auth header = %q", gotAuth)
	}
	if gotBucket != "1d" {
		t.Fatalf("bucket_width = %q, want 1d", gotBucket)
	}
	if len(pg.Records) != 2 {
		t.Fatalf("records = %d, want 2", len(pg.Records))
	}
	r0 := pg.Records[0]
	if r0.Provider != "openai" || r0.Model != "gpt-4o-2024-08-06" || r0.Day != "2026-06-15" ||
		r0.CostUSD != 12.5 || r0.Currency != "USD" || r0.VirtualKeyID != "proj_1" {
		t.Fatalf("record0 wrong: %+v", r0)
	}
	if !pg.Done {
		t.Fatal("single page should be Done")
	}
	// Watermark advanced to the latest day seen.
	if got := int64(pg.Next.Value["start_time"].(float64)); got != day {
		t.Fatalf("next watermark = %d, want %d", got, day)
	}
	if _, hasPage := pg.Next.Value["page"]; hasPage {
		t.Fatal("completed window must not carry a page token")
	}
}

func TestOpenAIFetchPagination(t *testing.T) {
	day := time.Date(2026, 6, 14, 0, 0, 0, 0, time.UTC).Unix()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "" {
			// first page → more to come
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []any{map[string]any{"start_time": day, "end_time": day + 86400,
					"results": []any{map[string]any{"amount": map[string]any{"value": 1.0, "currency": "usd"}, "line_item": "gpt-4o, input"}}}},
				"has_more": true, "next_page": "page_2",
			})
			return
		}
		// second page → done
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []any{map[string]any{"start_time": day + 86400, "end_time": day + 2*86400,
				"results": []any{map[string]any{"amount": map[string]any{"value": 2.0, "currency": "usd"}, "line_item": "gpt-4o, output"}}}},
			"has_more": false, "next_page": "",
		})
	}))
	defer srv.Close()

	_ = os.Setenv("OPENAI_ADMIN_KEY_TEST", "sk-admin")
	c := NewOpenAIConnector()
	c.now = fixedClock()
	cfg := map[string]any{"base_url": srv.URL, "api_key_env": "OPENAI_ADMIN_KEY_TEST"}

	pg1, err := c.Fetch(context.Background(), cfg, Cursor{})
	if err != nil {
		t.Fatal(err)
	}
	if pg1.Done {
		t.Fatal("first page should not be Done (has_more)")
	}
	if pg1.Next.Value["page"] != "page_2" {
		t.Fatalf("expected page token page_2, got %v", pg1.Next.Value["page"])
	}

	pg2, err := c.Fetch(context.Background(), cfg, pg1.Next)
	if err != nil {
		t.Fatal(err)
	}
	if !pg2.Done {
		t.Fatal("second page should be Done")
	}
	if len(pg1.Records)+len(pg2.Records) != 2 {
		t.Fatalf("total records = %d, want 2", len(pg1.Records)+len(pg2.Records))
	}
}

func TestOpenAIFetchMissingKey(t *testing.T) {
	_ = os.Unsetenv("OPENAI_ADMIN_KEY_ABSENT")
	c := NewOpenAIConnector()
	_, err := c.Fetch(context.Background(), map[string]any{"api_key_env": "OPENAI_ADMIN_KEY_ABSENT"}, Cursor{})
	if err == nil {
		t.Fatal("expected error when admin key env is empty")
	}
}

func TestOpenAIFetchErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":{"message":"invalid admin key"}}`, http.StatusUnauthorized)
	}))
	defer srv.Close()
	_ = os.Setenv("OPENAI_ADMIN_KEY_TEST", "bad")
	c := NewOpenAIConnector()
	c.now = fixedClock()
	_, err := c.Fetch(context.Background(), map[string]any{"base_url": srv.URL, "api_key_env": "OPENAI_ADMIN_KEY_TEST"}, Cursor{})
	if err == nil {
		t.Fatal("expected error on 401")
	}
}

func TestOpenAIDefaultWatermarkUsesLookback(t *testing.T) {
	// With an empty cursor, start_time must be lookback_days before "now".
	var gotStart string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotStart = r.URL.Query().Get("start_time")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}, "has_more": false})
	}))
	defer srv.Close()
	_ = os.Setenv("OPENAI_ADMIN_KEY_TEST", "sk")
	c := NewOpenAIConnector()
	c.now = fixedClock()
	_, err := c.Fetch(context.Background(), map[string]any{"base_url": srv.URL, "api_key_env": "OPENAI_ADMIN_KEY_TEST", "lookback_days": float64(10)}, Cursor{})
	if err != nil {
		t.Fatal(err)
	}
	want := startOfUTCDay(fixedClock()().AddDate(0, 0, -10))
	if gotStart != strconv.FormatInt(want, 10) {
		t.Fatalf("start_time = %q, want %d", gotStart, want)
	}
}
