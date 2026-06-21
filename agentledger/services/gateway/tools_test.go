package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ---- ToolGovernor unit tests ----

func TestToolGovernorUngovernedAgentAllowsAll(t *testing.T) {
	g := NewToolGovernor([]AgentToolAllowEntry{
		{TenantID: "t1", AgentID: "a1", ToolName: "search"},
	})
	// a2 has no allowlist rows → ungoverned → nothing is disallowed.
	if bad := g.Disallowed("t1", "a2", []string{"rm_rf", "exfiltrate"}); bad != nil {
		t.Fatalf("ungoverned agent should allow all, got %v", bad)
	}
	if g.Governed("t1", "a2") {
		t.Fatal("a2 should not be governed")
	}
}

func TestToolGovernorDenyByDefaultWithinScope(t *testing.T) {
	g := NewToolGovernor([]AgentToolAllowEntry{
		{TenantID: "t1", AgentID: "a1", ToolName: "search"},
		{TenantID: "t1", AgentID: "a1", MCPServer: "github"},
	})
	if !g.Governed("t1", "a1") {
		t.Fatal("a1 should be governed")
	}
	// allowed tool + allowed mcp server pass; unknown tool is blocked.
	bad := g.Disallowed("t1", "a1", []string{"search", "github", "delete_repo"})
	if len(bad) != 1 || bad[0] != "delete_repo" {
		t.Fatalf("expected only delete_repo blocked, got %v", bad)
	}
}

func TestToolGovernorTenantScoping(t *testing.T) {
	g := NewToolGovernor([]AgentToolAllowEntry{
		{TenantID: "t1", AgentID: "a1", ToolName: "search"},
	})
	// Same agent id under a different tenant must not inherit t1's allowlist;
	// it is ungoverned (allow all), never silently denied.
	if bad := g.Disallowed("t2", "a1", []string{"anything"}); bad != nil {
		t.Fatalf("cross-tenant agent must be ungoverned, got %v", bad)
	}
}

func TestToolGovernorDeduplicatesViolations(t *testing.T) {
	g := NewToolGovernor([]AgentToolAllowEntry{
		{TenantID: "t1", AgentID: "a1", ToolName: "search"},
	})
	bad := g.Disallowed("t1", "a1", []string{"x", "x", "", "y"})
	if len(bad) != 2 || bad[0] != "x" || bad[1] != "y" {
		t.Fatalf("expected deduped [x y], got %v", bad)
	}
}

func TestNilToolGovernorIsSafe(t *testing.T) {
	var g *ToolGovernor
	if g.Governed("t1", "a1") {
		t.Fatal("nil governor governs nothing")
	}
	if bad := g.Disallowed("t1", "a1", []string{"x"}); bad != nil {
		t.Fatalf("nil governor blocks nothing, got %v", bad)
	}
}

// ---- inline enforcement integration ----

// doChatTools issues a chat request with an agent id header and a tools array,
// capturing the emitted event (mirrors doChat in gateway_test.go).
func doChatTools(t *testing.T, g *Gateway, key, agentID string, tools []map[string]any) (*httptest.ResponseRecorder, LLMCallEvent) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"model":    "gpt-4o",
		"messages": []map[string]any{{"role": "user", "content": "hi"}},
		"tools":    tools,
	})
	r := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+key)
	if agentID != "" {
		r.Header.Set("X-AgentLedger-Agent-Id", agentID)
	}
	w := httptest.NewRecorder()

	evCh := make(chan LLMCallEvent, 1)
	origSink := g.sink
	g.sink = &EventSink{cfg: EventSinkCfg{}, ch: make(chan LLMCallEvent, 8)}
	go func() { evCh <- <-g.sink.ch }()

	g.handleChatCompletions(w, r)
	var ev LLMCallEvent
	select {
	case ev = <-evCh:
	case <-time.After(2 * time.Second):
		t.Fatal("no event emitted")
	}
	g.sink = origSink
	return w, ev
}

// funcTool builds an OpenAI function-tool definition.
func funcTool(name string) map[string]any {
	return map[string]any{"type": "function", "function": map[string]any{"name": name}}
}

// govGateway is testGateway plus a tool allowlist: agent "agent-gov" (tenant t1)
// may use only "search".
func govGateway(t *testing.T, upstreamURL string) *Gateway {
	g := testGateway(t, upstreamURL)
	snap := g.current.Load()
	g.current.Store(&gatewaySnapshot{
		cfg:    snap.cfg,
		keys:   snap.keys,
		dlp:    snap.dlp,
		tools:  NewToolGovernor([]AgentToolAllowEntry{{TenantID: "t1", AgentID: "agent-gov", ToolName: "search"}}),
		prices: snap.prices,
	})
	return g
}

func TestToolGovernanceBlocksDisallowedTool(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := govGateway(t, up.URL)

	w, ev := doChatTools(t, g, "alk_test", "agent-gov", []map[string]any{funcTool("delete_everything")})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
	if ev.Status != "blocked_tool" {
		t.Fatalf("status = %q, want blocked_tool", ev.Status)
	}
	if ev.RiskSeverity != "high" {
		t.Fatalf("risk_severity = %q, want high", ev.RiskSeverity)
	}
	if ev.AgentID != "agent-gov" {
		t.Fatalf("agent id not attributed: %+v", ev)
	}
}

func TestToolGovernanceAllowsListedTool(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := govGateway(t, up.URL)

	w, ev := doChatTools(t, g, "alk_test", "agent-gov", []map[string]any{funcTool("search")})
	if w.Code != 200 {
		t.Fatalf("allowed tool should pass, got %d: %s", w.Code, w.Body.String())
	}
	if ev.Status != "ok" {
		t.Fatalf("status = %q, want ok", ev.Status)
	}
}

func TestToolGovernanceUngovernedAgentPassesThrough(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := govGateway(t, up.URL)

	// agent-free request: no X-AgentLedger-Agent-Id → never blocked inline.
	w, _ := doChatTools(t, g, "alk_test", "", []map[string]any{funcTool("anything")})
	if w.Code != 200 {
		t.Fatalf("no-agent request must pass, got %d", w.Code)
	}
	// a different, unconfigured agent → ungoverned → passes.
	w2, _ := doChatTools(t, g, "alk_test", "agent-unconfigured", []map[string]any{funcTool("anything")})
	if w2.Code != 200 {
		t.Fatalf("unconfigured agent must pass, got %d", w2.Code)
	}
}

func TestToolGovernanceBlocksDisallowedMCPServer(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := govGateway(t, up.URL)

	mcp := map[string]any{"type": "mcp", "server_label": "prod-db"}
	w, ev := doChatTools(t, g, "alk_test", "agent-gov", []map[string]any{mcp})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for disallowed MCP server, got %d", w.Code)
	}
	if ev.Status != "blocked_tool" {
		t.Fatalf("status = %q, want blocked_tool", ev.Status)
	}
}

// TestAnthropicToolNamesCarriedThrough verifies the Messages→canonical
// translation surfaces Anthropic tool + mcp_server names to governance.
func TestAnthropicToolNamesCarriedThrough(t *testing.T) {
	areq := anthropicRequest{
		Model:      "claude-opus-4-8",
		Tools:      json.RawMessage(`[{"name":"search"},{"name":"delete_repo"}]`),
		MCPServers: json.RawMessage(`[{"name":"github","url":"https://x"}]`),
	}
	body := translateMessagesToCanonical(areq)
	var req chatRequest
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatalf("canonical body invalid: %v", err)
	}
	got := req.declaredTools()
	want := map[string]bool{"search": true, "delete_repo": true, "github": true}
	if len(got) != len(want) {
		t.Fatalf("declared tools = %v, want keys %v", got, want)
	}
	for _, n := range got {
		if !want[n] {
			t.Fatalf("unexpected declared tool %q (all: %v)", n, got)
		}
	}
}
