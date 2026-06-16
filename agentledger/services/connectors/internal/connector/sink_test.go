package connector

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClickHouseSinkWritesJSONEachRow(t *testing.T) {
	var gotQuery, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("query")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	sink := NewClickHouseSink(srv.URL, "agentledger", "default", "")
	recs := []Record{
		{TenantID: "t1", Day: "2026-06-15", Provider: "openai", Model: "gpt-4o", CostUSD: 1.25, Source: "openai_usage"},
		{TenantID: "t1", Day: "2026-06-15", Provider: "openai", Model: "gpt-4o-mini", CostUSD: 0.10, Source: "openai_usage"},
	}
	if err := sink.Write(context.Background(), recs); err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(gotQuery, "INSERT INTO agentledger.provider_costs") ||
		!strings.Contains(gotQuery, "FORMAT JSONEachRow") {
		t.Fatalf("query = %q", gotQuery)
	}
	lines := strings.Split(strings.TrimSpace(gotBody), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 NDJSON lines, got %d: %q", len(lines), gotBody)
	}
	if !strings.Contains(lines[0], `"cost_usd":1.25`) || !strings.Contains(lines[0], `"imported_at"`) {
		t.Fatalf("row 0 missing fields: %s", lines[0])
	}
	// Currency defaults to USD when unset.
	if !strings.Contains(lines[0], `"currency":"USD"`) {
		t.Fatalf("currency not defaulted: %s", lines[0])
	}
}

func TestClickHouseSinkEmptyIsNoop(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer srv.Close()
	sink := NewClickHouseSink(srv.URL, "agentledger", "", "")
	if err := sink.Write(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("empty write must not hit ClickHouse")
	}
}

func TestClickHouseSinkErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Code: 60. DB::Exception: Unknown table", http.StatusBadRequest)
	}))
	defer srv.Close()
	sink := NewClickHouseSink(srv.URL, "agentledger", "", "")
	err := sink.Write(context.Background(), []Record{{TenantID: "t1"}})
	if err == nil || !strings.Contains(err.Error(), "status 400") {
		t.Fatalf("err = %v, want status 400", err)
	}
}
