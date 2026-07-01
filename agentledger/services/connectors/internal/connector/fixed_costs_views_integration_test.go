package connector

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// Integration: seeds fixed_costs + llm_calls and asserts v_total_cost_of_ai math.
// Also asserts v_roi row count is unchanged by fixed_costs (attribution boundary guard).
func TestFixedCostsTotalCostViewIntegration(t *testing.T) {
	if os.Getenv("AGENTLEDGER_IT_CH") == "" {
		t.Skip("set AGENTLEDGER_IT_CH to run the live ClickHouse integration")
	}
	chURL := os.Getenv("AGENTLEDGER_CLICKHOUSE_URL")
	if chURL == "" {
		chURL = "http://localhost:8123"
	}
	tenant := fmt.Sprintf("it-tcoai-%d", time.Now().UnixNano())
	month := "2026-06-01"

	roiBefore := chQuery(t, chURL, "SELECT count() FROM agentledger.v_roi WHERE tenant_id='"+tenant+"'")

	sink := NewFixedCostSink(chURL, "agentledger", "", "")
	if err := sink.Write(context.Background(), []FixedCostRecord{{
		TenantID: tenant, PeriodMonth: month, Vendor: "openai", CostType: "seat_license",
		LineItem: "ChatGPT Team", CostUSD: 200, Source: "manual",
	}}); err != nil {
		t.Fatal(err)
	}

	llmInsert := fmt.Sprintf(`INSERT INTO agentledger.llm_calls FORMAT JSONEachRow
{"call_id":"fc-%s","ts":"2026-06-15 10:00:00","tenant_id":"%s","team_id":"t","user_id":"u","app_id":"a","virtual_key_id":"vk","provider":"openai","response_model":"gpt-4o","input_tokens":100,"output_tokens":50,"cost_usd":50,"status":"ok","source":"gateway","dlp_action":"allow"}`, tenant, tenant)
	chExec(t, chURL, llmInsert)

	row := chQuery(t, chURL, fmt.Sprintf(
		`SELECT round(attributable_cost_usd,2), round(fixed_cost_usd,2), round(total_cost_of_ai_usd,2), round(fixed_cost_pct,4)
		 FROM agentledger.v_total_cost_of_ai WHERE tenant_id='%s' AND month=toDate('%s') FORMAT TabSeparated`,
		tenant, month,
	))
	if row != "50\t200\t250\t0.8" {
		t.Fatalf("v_total_cost_of_ai = %q, want 50\\t200\\t250\\t0.8", row)
	}

	roiAfter := chQuery(t, chURL, "SELECT count() FROM agentledger.v_roi WHERE tenant_id='"+tenant+"'")
	if roiBefore != roiAfter {
		t.Fatalf("v_roi count changed %q -> %q; fixed costs must not affect attribution views", roiBefore, roiAfter)
	}
}

func chExec(t *testing.T, base, sql string) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, base+"/?"+url.Values{"query": {sql}}.Encode(), nil)
	if err != nil {
		t.Fatalf("ch exec build: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("ch exec: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("ch exec status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
}
