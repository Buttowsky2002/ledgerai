package connector

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestFixedCostSinkUsesTimeoutClient(t *testing.T) {
	sink := NewFixedCostSink("http://example.test", "agentledger", "", "")
	if sink.HTTPClient() == http.DefaultClient {
		t.Fatal("fixed cost sink must not use http.DefaultClient")
	}
	if sink.HTTPClient().Timeout != 30*time.Second {
		t.Fatalf("timeout = %v, want 30s", sink.HTTPClient().Timeout)
	}
}

func TestFixedCostSinkWritesJSONEachRow(t *testing.T) {
	var gotQuery, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("query")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	sink := NewFixedCostSink(srv.URL, "agentledger", "", "")
	recs := []FixedCostRecord{
		{
			TenantID: "t1", PeriodMonth: "2026-06-01", Vendor: "openai",
			CostType: "seat_license", LineItem: "ChatGPT Team", CostUSD: 600, Source: "manual",
		},
	}
	if err := sink.Write(context.Background(), recs); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotQuery, "INSERT INTO agentledger.fixed_costs") ||
		!strings.Contains(gotQuery, "FORMAT JSONEachRow") {
		t.Fatalf("query = %q", gotQuery)
	}
	if !strings.Contains(gotBody, `"attributable":0`) || !strings.Contains(gotBody, `"imported_at"`) {
		t.Fatalf("body missing fields: %q", gotBody)
	}
}

func TestFixedCostSinkIdempotentIdentity(t *testing.T) {
	if os.Getenv("AGENTLEDGER_IT_CH") == "" {
		t.Skip("set AGENTLEDGER_IT_CH to run the live ClickHouse integration")
	}
	chURL := os.Getenv("AGENTLEDGER_CLICKHOUSE_URL")
	if chURL == "" {
		chURL = "http://localhost:8123"
	}
	tenant := fmt.Sprintf("it-fx-%d", time.Now().UnixNano())
	sink := NewFixedCostSink(chURL, "agentledger", "", "")
	rec := FixedCostRecord{
		TenantID: tenant, PeriodMonth: "2026-06-01", Vendor: "openai",
		CostType: "subscription", LineItem: "ChatGPT Team", CostUSD: 100, Source: "manual",
	}
	if err := sink.Write(context.Background(), []FixedCostRecord{rec}); err != nil {
		t.Fatal(err)
	}
	rec.CostUSD = 120
	if err := sink.Write(context.Background(), []FixedCostRecord{rec}); err != nil {
		t.Fatal(err)
	}
	if got := chQuery(t, chURL, "SELECT count() FROM agentledger.fixed_costs FINAL WHERE tenant_id='"+tenant+"'"); got != "1" {
		t.Fatalf("row count = %q, want 1 (idempotent)", got)
	}
	if got := chQuery(t, chURL, "SELECT round(sum(cost_usd), 2) FROM agentledger.fixed_costs FINAL WHERE tenant_id='"+tenant+"'"); got != "120" {
		t.Fatalf("cost_usd = %q, want 120", got)
	}
}
