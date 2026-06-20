package attribution

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// Integration: the Phase 3 acceptance demo. Seeds an agent-stamped merged PR and
// a weak (time-only) outcome, runs the REAL attribution matcher against a live
// ClickHouse, then reads v_outcome_graph to prove cost -> agent -> outcome ->
// value is queryable end-to-end with a confidence on every edge, and that a
// low-confidence link is excluded from the headline (headline_eligible=0).
//
// Gated by AGENTLEDGER_IT_CH; run on the compose network with applied migrations
// and AGENTLEDGER_CLICKHOUSE_URL=http://clickhouse:8123.
func TestOutcomeGraphAttributionIntegration(t *testing.T) {
	if os.Getenv("AGENTLEDGER_IT_CH") == "" {
		t.Skip("set AGENTLEDGER_IT_CH to run the live ClickHouse integration")
	}
	chURL := os.Getenv("AGENTLEDGER_CLICKHOUSE_URL")
	if chURL == "" {
		chURL = "http://localhost:8123"
	}
	tenant := fmt.Sprintf("it-graph-%d", time.Now().UnixNano())
	pr := "github:" + tenant + "/repo#42" // stable outcome_id == run.outcome_id (SDK-asserted)

	// Two completed runs: r1 SDK-stamped with the PR's outcome_id (deterministic
	// link); r2 by a different user with an unrelated objective (only a time
	// signal to the weak outcome).
	chInsert(t, chURL, "agent_runs", []map[string]any{
		{"run_id": "r1", "tenant_id": tenant, "agent_id": "A1", "user_id": "u1",
			"started_at": "2026-06-10 09:00:00.000", "ended_at": "2026-06-10 09:05:00.000",
			"status": "completed", "objective": "fix #42", "outcome_id": pr,
			"total_cost_usd": 8, "total_tokens": 1000, "llm_calls": 5, "tool_calls": 2, "risk_events": 0},
		{"run_id": "r2", "tenant_id": tenant, "agent_id": "A2", "user_id": "u3",
			"started_at": "2026-06-10 10:40:00.000", "ended_at": "2026-06-10 10:50:00.000",
			"status": "completed", "objective": "unrelated task", "outcome_id": "",
			"total_cost_usd": 4, "total_tokens": 500, "llm_calls": 3, "tool_calls": 1, "risk_events": 0},
	})
	// Outcomes as the connectors emit them: run_id='', attribution_confidence=0.
	chInsert(t, chURL, "outcomes", []map[string]any{
		{"outcome_id": pr, "tenant_id": tenant, "ts": "2026-06-10 09:10:00.000",
			"source_system": "github", "outcome_type": "pr_merged", "team_id": "team1", "user_id": "u1",
			"run_id": "", "business_value_usd": 500, "quality_score": 0.9,
			"attribution_confidence": 0, "completion_status": "merged"},
		{"outcome_id": "zendesk:" + tenant + ":99", "tenant_id": tenant, "ts": "2026-06-10 11:00:00.000",
			"source_system": "zendesk", "outcome_type": "ticket_resolved", "team_id": "team1", "user_id": "u2",
			"run_id": "", "business_value_usd": 300, "quality_score": 0.4,
			"attribution_confidence": 0, "completion_status": "solved"},
	})

	// Run the real matcher (window 240m, lookback 35d, min confidence 0.3) at a
	// fixed "now" so the seeded June rows fall inside the lookback window.
	m := New(NewHTTPClient(chURL, "agentledger", "", ""), 240*time.Minute, 35, 0.3, nil)
	m.now = func() time.Time { return time.Date(2026, 6, 12, 0, 0, 0, 0, time.UTC) }
	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("matcher run: %v", err)
	}

	// The agent-stamped PR is attributed end-to-end: traced to its run/agent,
	// cost flows through, confidence 1.0 (deterministic), headline-eligible.
	hi := chRow(t, chURL, "SELECT run_id, agent_id, ai_cost_usd, business_value_usd, net_value_usd, round(attribution_confidence,3), headline_eligible "+
		"FROM agentledger.v_outcome_graph WHERE tenant_id='"+tenant+"' AND outcome_id='"+pr+"' FORMAT TabSeparated")
	if hi != "r1\tA1\t8\t500\t492\t1\t1" {
		t.Fatalf("agent-stamped PR trace = %q, want r1/A1/8/500/492/conf 1/headline 1", hi)
	}

	// The weak outcome is attributed only by time → 0.3 <= conf < 0.5, so it is
	// EXCLUDED from the headline (headline_eligible=0) — the acceptance bar.
	lo := chRow(t, chURL, "SELECT run_id, headline_eligible, attribution_confidence >= 0.3 AND attribution_confidence < 0.5 "+
		"FROM agentledger.v_outcome_graph WHERE tenant_id='"+tenant+"' AND outcome_id='zendesk:"+tenant+":99' FORMAT TabSeparated")
	if lo != "r2\t0\t1" {
		t.Fatalf("weak outcome trace = %q, want r2 / headline 0 / low-confidence band", lo)
	}

	// Exactly one headline-eligible outcome for the tenant (the PR).
	if got := chRow(t, chURL, "SELECT count() FROM agentledger.v_outcome_graph WHERE tenant_id='"+tenant+"' AND headline_eligible=1 FORMAT TabSeparated"); got != "1" {
		t.Fatalf("headline-eligible outcomes = %q, want 1", got)
	}
}

// chInsert seeds rows into a table via JSONEachRow.
func chInsert(t *testing.T, base, table string, rows []map[string]any) {
	t.Helper()
	var b strings.Builder
	enc := json.NewEncoder(&b)
	for _, r := range rows {
		if err := enc.Encode(r); err != nil {
			t.Fatalf("encode seed row: %v", err)
		}
	}
	q := url.Values{
		"query":                            {"INSERT INTO agentledger." + table + " FORMAT JSONEachRow"},
		"input_format_skip_unknown_fields": {"1"},
		"date_time_input_format":           {"best_effort"},
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, base+"/?"+q.Encode(), strings.NewReader(b.String()))
	if err != nil {
		t.Fatalf("ch insert %s: build request: %v", table, err)
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("ch insert %s: %v", table, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("ch insert %s status %d: %s", table, resp.StatusCode, body)
	}
}

// chRow runs a query and returns its single trimmed line of output.
func chRow(t *testing.T, base, q string) string {
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
		t.Fatalf("ch query status %d: %s", resp.StatusCode, b)
	}
	return strings.TrimSpace(string(b))
}
