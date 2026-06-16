package reconcile

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPClientReconciliationParsesAndBindsParam(t *testing.T) {
	var gotParam, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotParam = r.URL.Query().Get("param_since")
		b, _ := io.ReadAll(r.Body)
		gotQuery = string(b)
		// JSONEachRow: one object per line.
		_, _ = io.WriteString(w, `{"tenant_id":"t1","day":"2026-06-15","model":"gpt-4o","gateway_cost_usd":95,"provider_cost_usd":100,"drift_usd":5,"drift_pct":0.05}`+"\n")
		_, _ = io.WriteString(w, `{"tenant_id":"t1","day":"2026-06-15","model":"gpt-4o-mini","gateway_cost_usd":49.5,"provider_cost_usd":50,"drift_usd":0.5,"drift_pct":0.01}`+"\n")
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL, "agentledger", "default", "")
	rows, err := c.Reconciliation(context.Background(), "2026-05-12")
	if err != nil {
		t.Fatal(err)
	}
	if gotParam != "2026-05-12" {
		t.Fatalf("param_since = %q, want 2026-05-12", gotParam)
	}
	if !strings.Contains(gotQuery, "{since:Date}") || strings.Contains(gotQuery, "2026-05-12") {
		t.Fatalf("date must be a bound param, not inlined: %q", gotQuery)
	}
	if len(rows) != 2 || rows[0].Model != "gpt-4o" || rows[0].DriftPct != 0.05 {
		t.Fatalf("rows parsed wrong: %+v", rows)
	}
}

func TestHTTPClientWriteAdjustments(t *testing.T) {
	var gotQuery, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("query")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL, "agentledger", "default", "")
	adj := []Adjustment{
		{TenantID: "t1", Day: "2026-06-15", Model: "gpt-4o", DriftPct: 0.05, Flagged: 1, ThresholdPct: 0.02, ReconciledAt: "2026-06-16 09:00:00.000"},
	}
	if err := c.WriteAdjustments(context.Background(), adj); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotQuery, "INSERT INTO agentledger.cost_adjustments") || !strings.Contains(gotQuery, "JSONEachRow") {
		t.Fatalf("query = %q", gotQuery)
	}
	var got Adjustment
	if err := json.Unmarshal([]byte(strings.TrimSpace(gotBody)), &got); err != nil {
		t.Fatalf("body not JSONEachRow: %q", gotBody)
	}
	if got.Flagged != 1 || got.Model != "gpt-4o" {
		t.Fatalf("adjustment row wrong: %+v", got)
	}
}

func TestHTTPClientWriteEmptyIsNoop(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer srv.Close()
	c := NewHTTPClient(srv.URL, "agentledger", "", "")
	if err := c.WriteAdjustments(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("empty write must not hit ClickHouse")
	}
}

func TestHTTPClientQueryErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Code: 60. Unknown table", http.StatusBadRequest)
	}))
	defer srv.Close()
	c := NewHTTPClient(srv.URL, "agentledger", "", "")
	_, err := c.Reconciliation(context.Background(), "2026-05-12")
	if err == nil || !strings.Contains(err.Error(), "status 400") {
		t.Fatalf("err = %v, want status 400", err)
	}
}
