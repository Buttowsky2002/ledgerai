package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// mockUpstream emulates an OpenAI-compatible provider and echoes back
// whatever prompt content it received (so redaction can be asserted).
func mockUpstream(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		echo := ""
		if msgs, ok := req["messages"].([]any); ok && len(msgs) > 0 {
			if m, ok := msgs[0].(map[string]any); ok {
				echo, _ = m["content"].(string)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "chatcmpl-test", "model": "gpt-4o-2024-11-20",
			"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": echo}}},
			"usage": map[string]any{
				"prompt_tokens": 1000, "completion_tokens": 500,
				"prompt_tokens_details": map[string]any{"cached_tokens": 200},
			},
		})
	}))
}

func testGateway(t *testing.T, upstreamURL string) *Gateway {
	t.Helper()
	pb := &PriceBook{entries: []PriceEntry{
		{Provider: "openai", Model: "gpt-4o", TokenType: "input", USDPerMillion: 2.50, EffectiveStart: time.Unix(0, 0)},
		{Provider: "openai", Model: "gpt-4o", TokenType: "output", USDPerMillion: 10.00, EffectiveStart: time.Unix(0, 0)},
		{Provider: "openai", Model: "gpt-4o", TokenType: "cache_read", USDPerMillion: 1.25, EffectiveStart: time.Unix(0, 0)},
	}}
	cfg := &Config{
		Providers: []ProviderCfg{{Name: "openai", BaseURL: upstreamURL, APIKeyEnv: "TEST_UPSTREAM_KEY", ModelPrefixes: []string{"gpt-"}}},
		VirtualKeys: []VirtualKey{
			{KeyPlaintext: "alk_test", TenantID: "t1", TeamID: "eng", UserID: "u1", AppID: "app1",
				Environment: "test", MonthlyBudget: 100, DLPPolicyID: "default"},
			{KeyPlaintext: "alk_block", TenantID: "t1", TeamID: "sec", UserID: "u2", AppID: "app1",
				Environment: "test", DLPPolicyID: "strict"},
			{KeyPlaintext: "alk_redact", TenantID: "t1", TeamID: "fin", UserID: "u3", AppID: "app1",
				Environment: "test", DLPPolicyID: "redactor"},
			{KeyPlaintext: "alk_broke", TenantID: "t1", TeamID: "x", UserID: "u4", AppID: "app1",
				Environment: "test", MonthlyBudget: 0.000001},
		},
		DLP: DLPConfig{Policies: []DLPPolicy{
			{ID: "strict", Action: "block", Classes: []string{"credentials"}},
			{ID: "redactor", Action: "redact"},
			{ID: "default", Action: "log"},
		}},
	}
	_ = os.Setenv("TEST_UPSTREAM_KEY", "sk-upstream")

	return newGateway(cfg, pb,
		NewBudgetStore(cfg.VirtualKeys),
		NewEventSink(EventSinkCfg{Type: "file", Path: os.DevNull, FlushMs: 10, BufferSize: 64}))
}

func doChat(t *testing.T, g *Gateway, key, content string) (*httptest.ResponseRecorder, LLMCallEvent) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"model":    "gpt-4o",
		"messages": []map[string]any{{"role": "user", "content": content}},
	})
	r := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+key)
	w := httptest.NewRecorder()

	// Capture the emitted event: swap in a bare sink whose channel we read
	// directly (no flush goroutine), restoring the original afterwards.
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

func TestProxySuccessCostAndAttribution(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	w, ev := doChat(t, g, "alk_test", "Summarize Q2 revenue trends.")
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if ev.TenantID != "t1" || ev.TeamID != "eng" || ev.UserID != "u1" {
		t.Fatalf("attribution wrong: %+v", ev)
	}
	if ev.InputTokens != 1000 || ev.OutputTokens != 500 || ev.CacheReadTokens != 200 {
		t.Fatalf("usage wrong: %+v", ev)
	}
	// cost = 800*2.50/1M + 200*1.25/1M + 500*10/1M = 0.002 + 0.00025 + 0.005
	want := 0.00725
	if diff := ev.CostUSD - want; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("cost = %v, want %v", ev.CostUSD, want)
	}
	if ev.ResponseModel != "gpt-4o-2024-11-20" {
		t.Fatalf("response model = %q", ev.ResponseModel)
	}
}

func TestDLPBlockOnCredentials(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	w, ev := doChat(t, g, "alk_block", "debug this: key is AKIAIOSFODNN7EXAMPLE please")
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
	if ev.Status != "blocked_dlp" || ev.DLPAction != "block" {
		t.Fatalf("event = %+v", ev)
	}
	if ev.RiskSeverity != "critical" {
		t.Fatalf("severity = %q", ev.RiskSeverity)
	}
}

func TestDLPRedactionRewritesPrompt(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	w, ev := doChat(t, g, "alk_redact", "card 4111 1111 1111 1111 belongs to jane@corp.com")
	if w.Code != 200 {
		t.Fatalf("status = %d", w.Code)
	}
	if ev.DLPAction != "redact" {
		t.Fatalf("action = %q", ev.DLPAction)
	}
	// upstream echoes the (redacted) prompt back — assert no raw PAN leaked
	respBody := w.Body.String()
	if strings.Contains(respBody, "4111 1111 1111 1111") {
		t.Fatalf("raw card number reached upstream: %s", respBody)
	}
	if !strings.Contains(respBody, "[REDACTED:CREDIT_CARD]") {
		t.Fatalf("expected redaction token in upstream echo: %s", respBody)
	}
}

func TestBudgetEnforcement(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	// first call succeeds and books spend over the tiny budget
	w, _ := doChat(t, g, "alk_broke", "hello")
	if w.Code != 200 {
		t.Fatalf("first call should pass, got %d", w.Code)
	}
	// second call must be rejected pre-flight
	w2, ev2 := doChat(t, g, "alk_broke", "hello again")
	if w2.Code != http.StatusPaymentRequired {
		t.Fatalf("expected 402, got %d", w2.Code)
	}
	if ev2.Status != "blocked_budget" {
		t.Fatalf("event = %+v", ev2)
	}
}

func TestUnknownKeyRejected(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)
	body, _ := json.Marshal(map[string]any{"model": "gpt-4o", "messages": []any{}})
	r := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer alk_nope")
	w := httptest.NewRecorder()
	g.handleChatCompletions(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestLuhnSuppressesFalsePositives(t *testing.T) {
	d := NewDLPEngine(DLPConfig{})
	// a 16-digit number that fails Luhn (timestamp-like) must not match
	fs := d.Classify("order id 1234 5678 9012 3456 confirmed")
	for _, f := range fs {
		if f.Class == "credit_card" {
			t.Fatalf("false positive credit_card on non-Luhn number")
		}
	}
	fs = d.Classify("pay with 4111 1111 1111 1111 now")
	found := false
	for _, f := range fs {
		if f.Class == "credit_card" {
			found = true
		}
	}
	if !found {
		t.Fatal("valid PAN not detected")
	}
}

func TestPriceBookEffectiveDates(t *testing.T) {
	cut := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	pb := &PriceBook{entries: []PriceEntry{
		{Provider: "openai", Model: "gpt-4o", TokenType: "input", USDPerMillion: 5.0,
			EffectiveStart: time.Unix(0, 0), EffectiveEnd: &cut},
		{Provider: "openai", Model: "gpt-4o", TokenType: "input", USDPerMillion: 2.5,
			EffectiveStart: cut},
	}}
	old, _ := pb.Rate("openai", "gpt-4o", "input", cut.Add(-time.Hour))
	cur, _ := pb.Rate("openai", "gpt-4o", "input", cut.Add(time.Hour))
	if old != 5.0 || cur != 2.5 {
		t.Fatalf("effective dating broken: old=%v cur=%v", old, cur)
	}
}

func TestProviderLongestPrefixRouting(t *testing.T) {
	c := &Config{Providers: []ProviderCfg{
		{Name: "openai", ModelPrefixes: []string{"gpt-"}},
		{Name: "azure", ModelPrefixes: []string{"gpt-4o-azure"}},
	}}
	p, ok := c.resolveProvider("gpt-4o-azure-eu")
	if !ok || p.Name != "azure" {
		t.Fatalf("longest prefix routing failed: %+v", p)
	}
}

func ExampleLLMCallEvent_json() {
	e := LLMCallEvent{CallID: "call_x", TenantID: "t1", Provider: "openai", CostUSD: 0.01}
	b, _ := json.Marshal(e)
	fmt.Println(len(b) > 0)
	// Output: true
}
