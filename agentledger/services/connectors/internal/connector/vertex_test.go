package connector

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestVertexFetchSinglePage(t *testing.T) {
	var gotAuth, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		// BigQuery returns all cell values as strings.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jobComplete": true,
			"rows": []any{
				map[string]any{"f": []any{
					map[string]any{"v": "2026-06-15"},
					map[string]any{"v": "Vertex AI Gemini 1.5 Pro Input"},
					map[string]any{"v": "5.25"},
					map[string]any{"v": "USD"},
				}},
			},
		})
	}))
	defer srv.Close()

	os.Setenv("GCP_ACCESS_TOKEN", "ya29.token")
	c := NewVertexConnector()
	c.now = fixedClock()
	cfg := map[string]any{
		"base_url":      srv.URL,
		"project_id":    "my-proj",
		"billing_table": "my-proj.billing.gcp_billing_export_v1_XXXX",
	}

	pg, err := c.Fetch(context.Background(), cfg, Cursor{})
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer ya29.token" {
		t.Fatalf("auth = %q", gotAuth)
	}
	if !strings.Contains(gotPath, "/projects/my-proj/queries") {
		t.Fatalf("path = %q", gotPath)
	}
	// Date filter must be a NAMED parameter, never concatenated into SQL.
	if _, ok := gotBody["queryParameters"]; !ok {
		t.Fatalf("query parameters missing (must be parameterized): %v", gotBody)
	}
	q, _ := gotBody["query"].(string)
	if strings.Contains(q, "2026-") {
		t.Fatalf("date must not be inlined into SQL: %s", q)
	}
	if len(pg.Records) != 1 {
		t.Fatalf("records = %d, want 1", len(pg.Records))
	}
	r0 := pg.Records[0]
	if r0.Provider != "gcp_vertex" || r0.Day != "2026-06-15" || r0.CostUSD != 5.25 || r0.Currency != "USD" {
		t.Fatalf("record0 wrong: %+v", r0)
	}
	if !pg.Done {
		t.Fatal("vertex fetch should be Done (single query)")
	}
	if pg.Next.Value["start"] != "2026-06-15" {
		t.Fatalf("watermark = %v, want 2026-06-15", pg.Next.Value["start"])
	}
}

func TestVertexRejectsUnsafeTable(t *testing.T) {
	os.Setenv("GCP_ACCESS_TOKEN", "tok")
	c := NewVertexConnector()
	c.now = fixedClock()
	_, err := c.Fetch(context.Background(), map[string]any{
		"project_id":    "p",
		"billing_table": "billing`; DROP TABLE x; --",
	}, Cursor{})
	if err == nil || !strings.Contains(err.Error(), "unsafe format") {
		t.Fatalf("expected unsafe-table rejection, got %v", err)
	}
}

func TestVertexMissingConfig(t *testing.T) {
	os.Setenv("GCP_ACCESS_TOKEN", "tok")
	c := NewVertexConnector()
	_, err := c.Fetch(context.Background(), map[string]any{"project_id": "p"}, Cursor{})
	if err == nil {
		t.Fatal("expected error when billing_table is missing")
	}
}

func TestVertexMissingToken(t *testing.T) {
	os.Unsetenv("GCP_ACCESS_TOKEN")
	c := NewVertexConnector()
	_, err := c.Fetch(context.Background(), map[string]any{"project_id": "p", "billing_table": "a.b.c"}, Cursor{})
	if err == nil {
		t.Fatal("expected error when bearer token is absent")
	}
}
