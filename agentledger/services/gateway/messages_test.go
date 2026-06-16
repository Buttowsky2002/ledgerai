package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// mockStreamUpstream emulates an OpenAI-compatible provider that streams SSE
// chunks followed by a usage-only chunk and [DONE].
func mockStreamUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		chunks := []string{
			`{"id":"chatcmpl-stream","model":"gpt-4o-2024-11-20","choices":[{"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}`,
			`{"id":"chatcmpl-stream","model":"gpt-4o-2024-11-20","choices":[{"delta":{"content":"lo!"},"finish_reason":null}]}`,
			`{"id":"chatcmpl-stream","model":"gpt-4o-2024-11-20","choices":[{"delta":{},"finish_reason":"stop"}]}`,
			`{"id":"chatcmpl-stream","model":"gpt-4o-2024-11-20","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500,"prompt_tokens_details":{"cached_tokens":200}}}`,
		}
		for _, c := range chunks {
			_, _ = w.Write([]byte("data: " + c + "\n"))
		}
		_, _ = w.Write([]byte("data: [DONE]\n"))
	}))
}

// doMessages drives handleMessages with an Anthropic-format body and returns
// the response recorder plus the emitted event.
func doMessages(t *testing.T, g *Gateway, key string, reqBody map[string]any) (*httptest.ResponseRecorder, LLMCallEvent) {
	t.Helper()
	body, _ := json.Marshal(reqBody)
	r := httptest.NewRequest("POST", "/v1/messages", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+key)
	w := httptest.NewRecorder()

	evCh := make(chan LLMCallEvent, 1)
	origSink := g.sink
	g.sink = &EventSink{cfg: EventSinkCfg{}, ch: make(chan LLMCallEvent, 8)}
	go func() { evCh <- <-g.sink.ch }()

	g.handleMessages(w, r)
	var ev LLMCallEvent
	select {
	case ev = <-evCh:
	case <-time.After(2 * time.Second):
		t.Fatal("no event emitted")
	}
	g.sink = origSink
	return w, ev
}

func TestMessagesBufferedTranslation(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	w, ev := doMessages(t, g, "alk_test", map[string]any{
		"model":      "gpt-4o",
		"max_tokens": 1024,
		"system":     "You are concise.",
		"messages":   []map[string]any{{"role": "user", "content": "Hi"}},
	})
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	var resp struct {
		Type       string `json:"type"`
		Role       string `json:"role"`
		Model      string `json:"model"`
		StopReason string `json:"stop_reason"`
		Content    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Usage struct {
			InputTokens          int `json:"input_tokens"`
			OutputTokens         int `json:"output_tokens"`
			CacheReadInputTokens int `json:"cache_read_input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response is not valid JSON: %v / %s", err, w.Body.String())
	}
	if resp.Type != "message" || resp.Role != "assistant" {
		t.Fatalf("wrong envelope: %+v", resp)
	}
	if len(resp.Content) != 1 || resp.Content[0].Type != "text" {
		t.Fatalf("content not translated to blocks: %+v", resp.Content)
	}
	if resp.StopReason != "end_turn" {
		t.Fatalf("stop_reason = %q, want end_turn", resp.StopReason)
	}
	// usage: prompt 1000 incl 200 cached → input_tokens 800, cache_read 200
	if resp.Usage.InputTokens != 800 || resp.Usage.OutputTokens != 500 || resp.Usage.CacheReadInputTokens != 200 {
		t.Fatalf("anthropic usage wrong: %+v", resp.Usage)
	}
	// cost + attribution still computed via the shared inline path
	if ev.CostUSD <= 0 || ev.TenantID != "t1" {
		t.Fatalf("event not booked through inline path: %+v", ev)
	}
	if !strings.Contains(w.Body.String(), "\"id\":\"msg_") {
		t.Fatalf("id not normalized to msg_: %s", w.Body.String())
	}
}

func TestMessagesContentBlocksFlattened(t *testing.T) {
	// Echoing upstream lets us assert the user text survived translation.
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	w, _ := doMessages(t, g, "alk_test", map[string]any{
		"model":      "gpt-4o",
		"max_tokens": 64,
		"messages": []map[string]any{
			{"role": "user", "content": []map[string]any{
				{"type": "text", "text": "block one"},
				{"type": "text", "text": "block two"},
			}},
		},
	})
	if w.Code != 200 {
		t.Fatalf("status = %d", w.Code)
	}
	echoed := w.Body.String()
	if !strings.Contains(echoed, "block one") || !strings.Contains(echoed, "block two") {
		t.Fatalf("content blocks not flattened into prompt: %s", echoed)
	}
}

func TestMessagesStreamingTranslation(t *testing.T) {
	up := mockStreamUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	w, ev := doMessages(t, g, "alk_test", map[string]any{
		"model":      "gpt-4o",
		"max_tokens": 64,
		"stream":     true,
		"messages":   []map[string]any{{"role": "user", "content": "stream please"}},
	})
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	out := w.Body.String()

	// The Anthropic streaming event sequence must be present and ordered.
	for _, want := range []string{
		"event: message_start",
		"event: content_block_start",
		"event: content_block_delta",
		"event: content_block_stop",
		"event: message_delta",
		"event: message_stop",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in stream:\n%s", want, out)
		}
	}
	if strings.Index(out, "message_start") > strings.Index(out, "message_stop") {
		t.Fatalf("events out of order:\n%s", out)
	}
	// text deltas reassemble to the upstream completion
	if !strings.Contains(out, `"text":"Hel"`) || !strings.Contains(out, `"text":"lo!"`) {
		t.Fatalf("text deltas not translated:\n%s", out)
	}
	// usage captured from the final OpenAI chunk drives cost accounting
	if ev.InputTokens != 1000 || ev.OutputTokens != 500 || ev.CacheReadTokens != 200 {
		t.Fatalf("streamed usage not captured: %+v", ev)
	}
	if ev.CostUSD <= 0 || !ev.Streamed {
		t.Fatalf("streamed event not booked: %+v", ev)
	}
}

func TestMessagesDLPBlockReturnsAnthropicError(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	w, ev := doMessages(t, g, "alk_block", map[string]any{
		"model":      "gpt-4o",
		"max_tokens": 64,
		"messages":   []map[string]any{{"role": "user", "content": "key AKIAIOSFODNN7EXAMPLE here"}},
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
	var e struct {
		Type  string `json:"type"`
		Error struct {
			Type string `json:"type"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil {
		t.Fatalf("error body not JSON: %s", w.Body.String())
	}
	if e.Type != "error" || e.Error.Type != "permission_error" {
		t.Fatalf("not an anthropic error envelope: %s", w.Body.String())
	}
	if ev.Status != "blocked_dlp" {
		t.Fatalf("event status = %q", ev.Status)
	}
}

func TestMessagesUnknownKeyAnthropicError(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	body, _ := json.Marshal(map[string]any{"model": "gpt-4o", "max_tokens": 8, "messages": []any{}})
	r := httptest.NewRequest("POST", "/v1/messages", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer alk_nope")
	w := httptest.NewRecorder()
	g.handleMessages(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "authentication_error") {
		t.Fatalf("expected anthropic authentication_error: %s", w.Body.String())
	}
}

func TestStopReasonMapping(t *testing.T) {
	cases := map[string]string{
		"stop": "end_turn", "length": "max_tokens",
		"tool_calls": "tool_use", "content_filter": "end_turn", "": "end_turn",
	}
	for in, want := range cases {
		if got := mapStopReason(in); got != want {
			t.Errorf("mapStopReason(%q) = %q, want %q", in, got, want)
		}
	}
}
