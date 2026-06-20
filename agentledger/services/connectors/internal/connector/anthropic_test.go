package connector

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestFlexFloatParsing(t *testing.T) {
	cases := map[string]float64{
		`12.5`:    12.5,
		`"12.50"`: 12.5,
		`"0"`:     0,
		`""`:      0,
		`null`:    0,
		`3`:       3,
	}
	for in, want := range cases {
		var f flexFloat
		if err := json.Unmarshal([]byte(in), &f); err != nil {
			t.Fatalf("unmarshal %s: %v", in, err)
		}
		if float64(f) != want {
			t.Errorf("flexFloat(%s) = %v, want %v", in, float64(f), want)
		}
	}
}

func TestAnthropicFetchSinglePage(t *testing.T) {
	var gotKey, gotVersion string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("x-api-key")
		gotVersion = r.Header.Get("anthropic-version")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []any{map[string]any{
				"starting_at": "2026-06-15T00:00:00Z",
				"results": []any{
					// amount as string (Anthropic style) and as number
					map[string]any{"amount": "12.50", "currency": "USD", "model": "claude-3-5-sonnet-20241022", "cost_type": "tokens"},
					map[string]any{"amount": 0.75, "currency": "USD", "model": "claude-3-5-haiku-20241022", "cost_type": "tokens"},
				},
			}},
			"has_more": false,
		})
	}))
	defer srv.Close()

	_ = os.Setenv("ANTHROPIC_ADMIN_KEY_TEST", "sk-ant-admin-xxx")
	c := NewAnthropicConnector()
	c.now = fixedClock()
	cfg := map[string]any{"base_url": srv.URL, "api_key_env": "ANTHROPIC_ADMIN_KEY_TEST"}

	pg, err := c.Fetch(context.Background(), cfg, Cursor{})
	if err != nil {
		t.Fatal(err)
	}
	if gotKey != "sk-ant-admin-xxx" {
		t.Fatalf("x-api-key = %q", gotKey)
	}
	if gotVersion != "2023-06-01" {
		t.Fatalf("anthropic-version = %q", gotVersion)
	}
	if len(pg.Records) != 2 {
		t.Fatalf("records = %d, want 2", len(pg.Records))
	}
	r0 := pg.Records[0]
	if r0.Provider != "anthropic" || r0.Model != "claude-3-5-sonnet-20241022" ||
		r0.Day != "2026-06-15" || r0.CostUSD != 12.5 || r0.Currency != "USD" {
		t.Fatalf("record0 wrong: %+v", r0)
	}
	if pg.Records[1].CostUSD != 0.75 {
		t.Fatalf("record1 cost = %v, want 0.75", pg.Records[1].CostUSD)
	}
	if !pg.Done {
		t.Fatal("single page should be Done")
	}
	if pg.Next.Value["starting_at"] != "2026-06-15T00:00:00Z" {
		t.Fatalf("watermark = %v, want latest bucket start", pg.Next.Value["starting_at"])
	}
}

func TestAnthropicFetchPagination(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []any{map[string]any{"starting_at": "2026-06-14T00:00:00Z",
					"results": []any{map[string]any{"amount": "1.00", "currency": "USD", "model": "claude-3-5-sonnet"}}}},
				"has_more": true, "next_page": "page_2",
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []any{map[string]any{"starting_at": "2026-06-15T00:00:00Z",
				"results": []any{map[string]any{"amount": "2.00", "currency": "USD", "model": "claude-3-5-sonnet"}}}},
			"has_more": false,
		})
	}))
	defer srv.Close()

	_ = os.Setenv("ANTHROPIC_ADMIN_KEY_TEST", "sk-ant")
	c := NewAnthropicConnector()
	c.now = fixedClock()
	cfg := map[string]any{"base_url": srv.URL, "api_key_env": "ANTHROPIC_ADMIN_KEY_TEST"}

	pg1, err := c.Fetch(context.Background(), cfg, Cursor{})
	if err != nil {
		t.Fatal(err)
	}
	if pg1.Done || pg1.Next.Value["page"] != "page_2" {
		t.Fatalf("first page should carry page_2 and not be Done: %+v", pg1.Next)
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

func TestAnthropicFetchMissingKey(t *testing.T) {
	_ = os.Unsetenv("ANTHROPIC_ADMIN_KEY_ABSENT")
	c := NewAnthropicConnector()
	_, err := c.Fetch(context.Background(), map[string]any{"api_key_env": "ANTHROPIC_ADMIN_KEY_ABSENT"}, Cursor{})
	if err == nil {
		t.Fatal("expected error when admin key env is empty")
	}
}

func TestAnthropicFetchErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"type":"error","error":{"message":"invalid x-api-key"}}`, http.StatusUnauthorized)
	}))
	defer srv.Close()
	_ = os.Setenv("ANTHROPIC_ADMIN_KEY_TEST", "bad")
	c := NewAnthropicConnector()
	c.now = fixedClock()
	_, err := c.Fetch(context.Background(), map[string]any{"base_url": srv.URL, "api_key_env": "ANTHROPIC_ADMIN_KEY_TEST"}, Cursor{})
	if err == nil {
		t.Fatal("expected error on 401")
	}
}

func TestDayOf(t *testing.T) {
	if got := dayOf("2026-06-15T00:00:00Z"); got != "2026-06-15" {
		t.Errorf("dayOf RFC3339 = %q", got)
	}
	if got := dayOf("2026-06-15"); got != "2026-06-15" {
		t.Errorf("dayOf bare date = %q", got)
	}
}
