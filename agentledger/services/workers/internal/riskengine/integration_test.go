package riskengine

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func jsonLine(t *testing.T, row map[string]any) string {
	t.Helper()
	b, err := json.Marshal(row)
	if err != nil {
		t.Fatalf("marshal seed row: %v", err)
	}
	return string(b)
}

func mustFloat(t *testing.T, s string) float64 {
	t.Helper()
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		t.Fatalf("parse float %q: %v", s, err)
	}
	return f
}

// Integration: drives the REAL risk engine against a live ClickHouse and proves
// the Phase 5 chain — a disallowed tool call becomes a governed risk event and
// raises the agent's risk_exposure_pct, which v_roi turns into a LOWER
// risk-adjusted ROI. Gated by AGENTLEDGER_IT_CH; run on the compose network with
// applied migrations and AGENTLEDGER_CLICKHOUSE_URL.
func TestRiskEngineLowersRoiIntegration(t *testing.T) {
	if os.Getenv("AGENTLEDGER_IT_CH") == "" {
		t.Skip("set AGENTLEDGER_IT_CH to run the live ClickHouse integration")
	}
	chURL := os.Getenv("AGENTLEDGER_CLICKHOUSE_URL")
	if chURL == "" {
		chURL = "http://localhost:8123"
	}
	tenant := fmt.Sprintf("it-risk-%d", time.Now().UnixNano())
	agent := "A1"

	// ROI inputs: a template rate, an agent run (cost), an attributed outcome.
	chInsert(t, chURL, "roi_rates", []map[string]any{
		{"tenant_id": tenant, "source_system": "github", "outcome_type": "pr_merged", "hourly_rate": 120, "baseline_minutes": 60, "updated_at": "2026-06-10 09:00:00.000"},
	})
	chInsert(t, chURL, "agent_runs", []map[string]any{
		{"run_id": "r1", "tenant_id": tenant, "agent_id": agent, "user_id": "u", "started_at": "2026-06-10 09:00:00", "ended_at": "2026-06-10 09:05:00", "status": "completed", "total_cost_usd": 5, "total_tokens": 10, "llm_calls": 1, "tool_calls": 3, "risk_events": 0},
	})
	chInsert(t, chURL, "outcomes", []map[string]any{
		{"outcome_id": "o1", "tenant_id": tenant, "ts": "2026-06-10 09:10:00", "source_system": "github", "outcome_type": "pr_merged", "team_id": "t", "user_id": "u", "run_id": "r1", "business_value_usd": 0, "quality_score": 0.9, "attribution_confidence": 0.9, "completion_status": "merged"},
	})
	// Governance: agent may use 'search'; it also calls 'shell_exec' twice.
	chInsert(t, chURL, "agent_tool_allow", []map[string]any{
		{"tenant_id": tenant, "agent_id": agent, "tool_name": "search", "allowed": 1, "updated_at": "2026-06-10 09:00:00.000"},
	})
	chInsert(t, chURL, "agent_tool_calls", []map[string]any{
		{"tenant_id": tenant, "agent_id": agent, "run_id": "r1", "tool_call_id": "tc1", "tool_name": "search", "ts": "2026-06-10 09:01:00"},
		{"tenant_id": tenant, "agent_id": agent, "run_id": "r1", "tool_call_id": "tc2", "tool_name": "shell_exec", "ts": "2026-06-10 09:02:00"},
		{"tenant_id": tenant, "agent_id": agent, "run_id": "r1", "tool_call_id": "tc3", "tool_name": "shell_exec", "ts": "2026-06-10 09:03:00"},
	})

	// Baseline risk-adjusted ROI (no risk yet) == expected (confidence-weighted).
	before := chScalar(t, chURL, fmt.Sprintf(
		"SELECT round(risk_adjusted_roi_usd, 2) FROM agentledger.v_roi WHERE tenant_id='%s' AND outcome_id='o1'", tenant))

	// Run the real engine.
	e := New(NewHTTPClient(chURL, "agentledger", "", ""), 5, nil)
	if err := e.Run(context.Background()); err != nil {
		t.Fatalf("engine run: %v", err)
	}

	// A governed unauthorized_tool event was raised for the disallowed tool.
	ev := chScalar(t, chURL, fmt.Sprintf(
		"SELECT category, detail, severity FROM agentledger.risk_events FINAL WHERE tenant_id='%s' AND agent_id='%s' FORMAT TabSeparated", tenant, agent))
	if ev != "unauthorized_tool\tshell_exec\tmedium" {
		t.Fatalf("risk event = %q, want unauthorized_tool/shell_exec/medium", ev)
	}

	// agent_risk now carries the 2/3 exposure.
	exposure := chScalar(t, chURL, fmt.Sprintf(
		"SELECT round(risk_exposure_pct, 4) FROM agentledger.agent_risk FINAL WHERE tenant_id='%s' AND agent_id='%s'", tenant, agent))
	if exposure != "0.6667" {
		t.Fatalf("risk_exposure_pct = %q, want 0.6667", exposure)
	}

	// And risk-adjusted ROI dropped accordingly.
	after := chScalar(t, chURL, fmt.Sprintf(
		"SELECT round(risk_adjusted_roi_usd, 2) FROM agentledger.v_roi WHERE tenant_id='%s' AND outcome_id='o1'", tenant))
	if before == after {
		t.Fatalf("risk-adjusted ROI did not change: before=%s after=%s", before, after)
	}
	bf, af := mustFloat(t, before), mustFloat(t, after)
	if af >= bf {
		t.Fatalf("risk-adjusted ROI should drop: before=%v after=%v", bf, af)
	}
}

func chInsert(t *testing.T, base, table string, rows []map[string]any) {
	t.Helper()
	var b strings.Builder
	for _, r := range rows {
		b.WriteString(jsonLine(t, r))
		b.WriteByte('\n')
	}
	q := url.Values{
		"query":                            {"INSERT INTO agentledger." + table + " FORMAT JSONEachRow"},
		"input_format_skip_unknown_fields": {"1"},
		"date_time_input_format":           {"best_effort"},
	}
	resp, err := http.Post(base+"/?"+q.Encode(), "application/x-ndjson", strings.NewReader(b.String()))
	if err != nil {
		t.Fatalf("ch insert %s: %v", table, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("ch insert %s status %d: %s", table, resp.StatusCode, body)
	}
}

func chScalar(t *testing.T, base, q string) string {
	t.Helper()
	resp, err := http.Get(base + "/?default_format=TabSeparated&query=" + url.QueryEscape(q))
	if err != nil {
		t.Fatalf("ch query: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("ch query status %d: %s", resp.StatusCode, body)
	}
	return strings.TrimSpace(string(body))
}
