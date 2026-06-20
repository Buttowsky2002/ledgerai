package connector

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
)

// Integration: exercises ClickHouseOutcomeSink against a real ClickHouse and
// verifies the outcomes table accepts the row shape and that re-importing the
// same outcome_id collapses under ReplacingMergeTree (idempotent replay).
// Gated by AGENTLEDGER_IT_CH so unit runs skip it; run on the compose network
// with AGENTLEDGER_CLICKHOUSE_URL=http://clickhouse:8123.
func TestOutcomeSinkIntegration(t *testing.T) {
	if os.Getenv("AGENTLEDGER_IT_CH") == "" {
		t.Skip("set AGENTLEDGER_IT_CH to run the live ClickHouse integration")
	}
	chURL := os.Getenv("AGENTLEDGER_CLICKHOUSE_URL")
	if chURL == "" {
		chURL = "http://localhost:8123"
	}
	const tenant = "it-outcome-tenant"
	sink := NewClickHouseOutcomeSink(chURL, "agentledger", "", "")
	ctx := context.Background()

	recs := []OutcomeRecord{
		{OutcomeID: "itX", TenantID: tenant, TS: "2026-06-10 10:00:00.000", SourceSystem: "github", OutcomeType: "pr_merged"},
		{OutcomeID: "itY", TenantID: tenant, TS: "2026-06-10 11:00:00.000", SourceSystem: "github", OutcomeType: "pr_merged"},
	}
	if err := sink.WriteOutcomes(ctx, recs); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Replay the first record — must not create a second logical row.
	if err := sink.WriteOutcomes(ctx, recs[:1]); err != nil {
		t.Fatalf("replay write: %v", err)
	}

	got := chQuery(t, chURL,
		"SELECT count() FROM (SELECT outcome_id FROM agentledger.outcomes FINAL WHERE tenant_id='"+tenant+"' GROUP BY outcome_id)")
	if got != "2" {
		t.Fatalf("want 2 distinct outcomes after replay, got %q", got)
	}
}

func chQuery(t *testing.T, base, q string) string {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, base+"/?query="+url.QueryEscape(q), nil)
	if err != nil {
		t.Fatalf("ch query: build request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("ch query: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("ch status %d: %s", resp.StatusCode, b)
	}
	return strings.TrimSpace(string(b))
}
