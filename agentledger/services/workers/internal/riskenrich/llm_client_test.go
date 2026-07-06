package riskenrich

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const validCompletion = `{"choices":[{"message":{"content":"{\"findings\":[{\"category\":\"data_egress\",\"severity\":\"high\",\"confidence\":0.9,\"rationale\":\"read then external send\"}]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":30}}`

func TestOpenAICompatibleClientHappyPath(t *testing.T) {
	var gotReq chatCompletionsReq
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotReq)
		_, _ = w.Write([]byte(validCompletion))
	}))
	defer srv.Close()

	m := &LLMMetrics{}
	c := NewOpenAICompatibleClient(srv.URL, "badger-ai-8b", "tok", time.Second, m)
	resp, err := c.Chat(context.Background(), ChatRequest{
		System: "sys", User: "usr", JSONSchema: assessmentSchema(),
		SchemaName: "risk_assessment", MaxTokens: 2000, Temperature: 0.2,
	})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}

	if gotPath != "/v1/chat/completions" {
		t.Errorf("path = %q, want /v1/chat/completions", gotPath)
	}
	if gotAuth != "Bearer tok" {
		t.Errorf("auth = %q, want Bearer tok", gotAuth)
	}
	if gotReq.Model != "badger-ai-8b" {
		t.Errorf("model = %q", gotReq.Model)
	}
	if len(gotReq.Messages) != 2 || gotReq.Messages[0].Role != "system" || gotReq.Messages[1].Role != "user" {
		t.Errorf("messages = %+v, want system+user", gotReq.Messages)
	}
	// Structured-output request shape: both response_format and the vLLM guided_json.
	if gotReq.ResponseFormat == nil || gotReq.ResponseFormat.Type != "json_schema" {
		t.Errorf("response_format = %+v, want json_schema", gotReq.ResponseFormat)
	}
	if gotReq.ResponseFormat.JSONSchema == nil || gotReq.ResponseFormat.JSONSchema.Schema["type"] != "object" {
		t.Errorf("json_schema.schema missing or wrong: %+v", gotReq.ResponseFormat)
	}
	if gotReq.GuidedJSON == nil {
		t.Errorf("guided_json should be sent alongside response_format")
	}
	// Response + token accounting.
	if !strings.Contains(resp.Content, "data_egress") {
		t.Errorf("content = %q", resp.Content)
	}
	if resp.PromptTokens != 120 || resp.CompletionTokens != 30 {
		t.Errorf("tokens = %d/%d, want 120/30", resp.PromptTokens, resp.CompletionTokens)
	}
	if m.Requests.Load() != 1 || m.PromptTokens.Load() != 120 || m.CompletionTokens.Load() != 30 {
		t.Errorf("metrics off: reqs=%d pt=%d ct=%d", m.Requests.Load(), m.PromptTokens.Load(), m.CompletionTokens.Load())
	}
}

func TestOpenAICompatibleClientOmitsStructuredOutputWhenNoSchema(t *testing.T) {
	var gotReq chatCompletionsReq
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotReq)
		_, _ = w.Write([]byte(validCompletion))
	}))
	defer srv.Close()

	c := NewOpenAICompatibleClient(srv.URL, "", "", time.Second, nil)
	if _, err := c.Chat(context.Background(), ChatRequest{System: "s", User: "u", MaxTokens: 10}); err != nil {
		t.Fatalf("chat: %v", err)
	}
	if gotReq.ResponseFormat != nil || gotReq.GuidedJSON != nil {
		t.Errorf("no schema → no response_format/guided_json, got %+v / %v", gotReq.ResponseFormat, gotReq.GuidedJSON)
	}
	if gotReq.Model != "badger-ai-8b" {
		t.Errorf("default model = %q, want badger-ai-8b", gotReq.Model)
	}
}

func TestOpenAICompatibleClientRetriesOn500(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if hits.Add(1) <= 2 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"upstream boom"}`))
			return
		}
		_, _ = w.Write([]byte(validCompletion))
	}))
	defer srv.Close()

	m := &LLMMetrics{}
	c := NewOpenAICompatibleClient(srv.URL, "badger-ai-8b", "", time.Second, m)
	c.sleep = func(time.Duration) {} // no real backoff in tests
	resp, err := c.Chat(context.Background(), ChatRequest{System: "s", User: "u"})
	if err != nil {
		t.Fatalf("chat should succeed after retries: %v", err)
	}
	if !strings.Contains(resp.Content, "data_egress") {
		t.Errorf("content = %q", resp.Content)
	}
	if hits.Load() != 3 {
		t.Errorf("server hits = %d, want 3 (2 failures + 1 success)", hits.Load())
	}
	if m.Requests.Load() != 1 || m.Retries.Load() != 2 || m.Failures.Load() != 0 {
		t.Errorf("metrics: reqs=%d retries=%d fails=%d, want 1/2/0", m.Requests.Load(), m.Retries.Load(), m.Failures.Load())
	}
}

func TestOpenAICompatibleClientTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release // block past the client timeout on every attempt
	}))
	defer srv.Close()
	defer close(release)

	m := &LLMMetrics{}
	c := NewOpenAICompatibleClient(srv.URL, "badger-ai-8b", "", 20*time.Millisecond, m)
	c.sleep = func(time.Duration) {}
	_, err := c.Chat(context.Background(), ChatRequest{System: "s", User: "u"})
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if m.Failures.Load() != 1 {
		t.Errorf("Failures = %d, want 1", m.Failures.Load())
	}
	if m.Retries.Load() != 2 {
		t.Errorf("Retries = %d, want 2 (timeouts are retryable)", m.Retries.Load())
	}
}

func TestOpenAICompatibleClientDoesNotLeakBodyOn4xx(t *testing.T) {
	const secretBody = "SENSITIVE-UPSTREAM-DETAIL"
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(secretBody))
	}))
	defer srv.Close()

	m := &LLMMetrics{}
	c := NewOpenAICompatibleClient(srv.URL, "badger-ai-8b", "", time.Second, m)
	c.sleep = func(time.Duration) {}
	_, err := c.Chat(context.Background(), ChatRequest{System: "s", User: "u"})
	if err == nil {
		t.Fatal("expected error on 400")
	}
	if strings.Contains(err.Error(), secretBody) {
		t.Errorf("error must not carry the response body: %q", err.Error())
	}
	if hits.Load() != 1 {
		t.Errorf("4xx must not be retried, hits = %d, want 1", hits.Load())
	}
	if m.Retries.Load() != 0 {
		t.Errorf("Retries = %d, want 0 on 4xx", m.Retries.Load())
	}
}
