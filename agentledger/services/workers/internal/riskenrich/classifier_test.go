package riskenrich

import (
	"context"
	"errors"
	"testing"
)

// stubLLM returns scripted responses in order; the last entry repeats.
type stubLLM struct {
	responses []stubResp
	calls     int
	gotReqs   []ChatRequest
}

type stubResp struct {
	content string
	err     error
}

func (s *stubLLM) Chat(_ context.Context, req ChatRequest) (ChatResponse, error) {
	s.gotReqs = append(s.gotReqs, req)
	i := s.calls
	s.calls++
	if i >= len(s.responses) {
		i = len(s.responses) - 1
	}
	r := s.responses[i]
	return ChatResponse{Content: r.content}, r.err
}

func TestLLMClassifierValidJSON(t *testing.T) {
	llm := &stubLLM{responses: []stubResp{{content: `{"findings":[{"category":"data_egress","severity":"high","confidence":0.88,"rationale":"read then external send"}]}`}}}
	m := &LLMMetrics{}
	c := NewLLMClassifier(llm, 2000, m)
	a, err := c.Classify(context.Background(), AgentBehavior{AgentID: "a1", RunID: "r1", Tools: []string{"read_file", "http_post"}, CallCount: 2})
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if len(a.Findings) != 1 || a.Findings[0].Category != "data_egress" || a.Findings[0].Confidence != 0.88 {
		t.Fatalf("unexpected assessment: %+v", a)
	}
	// The request must carry the metadata-only prompt and the JSON schema.
	if len(llm.gotReqs) != 1 || llm.gotReqs[0].JSONSchema == nil {
		t.Errorf("expected one schema-constrained request, got %d", len(llm.gotReqs))
	}
	if m.Malformed.Load() != 0 || m.Fallbacks.Load() != 0 {
		t.Errorf("clean parse should not increment malformed/fallback")
	}
}

func TestLLMClassifierMalformedThenFallback(t *testing.T) {
	llm := &stubLLM{responses: []stubResp{{content: "sorry, I can't do that"}, {content: "still not json"}}}
	m := &LLMMetrics{}
	c := NewLLMClassifier(llm, 2000, m)
	a, err := c.Classify(context.Background(), AgentBehavior{AgentID: "a1", RunID: "r1"})
	if err != nil {
		t.Fatalf("fallback must not error: %v", err)
	}
	if len(a.Findings) != 0 {
		t.Fatalf("fallback must be empty, got %+v", a)
	}
	if llm.calls != 2 {
		t.Errorf("expected one retry (2 calls), got %d", llm.calls)
	}
	if m.Malformed.Load() != 1 || m.Fallbacks.Load() != 1 {
		t.Errorf("metrics: malformed=%d fallbacks=%d, want 1/1", m.Malformed.Load(), m.Fallbacks.Load())
	}
}

func TestLLMClassifierMalformedThenValidOnRetry(t *testing.T) {
	llm := &stubLLM{responses: []stubResp{
		{content: "here you go:"},
		{content: `{"findings":[{"category":"injection_suspected","severity":"high","confidence":0.7,"rationale":"read untrusted mcp then send"}]}`},
	}}
	m := &LLMMetrics{}
	c := NewLLMClassifier(llm, 2000, m)
	a, err := c.Classify(context.Background(), AgentBehavior{AgentID: "a1", RunID: "r1"})
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if len(a.Findings) != 1 || a.Findings[0].Category != "injection_suspected" {
		t.Fatalf("expected retry to succeed: %+v", a)
	}
	if m.Malformed.Load() != 1 || m.Fallbacks.Load() != 0 {
		t.Errorf("metrics: malformed=%d fallbacks=%d, want 1/0", m.Malformed.Load(), m.Fallbacks.Load())
	}
}

func TestLLMClassifierRejectsInvalidCategory(t *testing.T) {
	// One hallucinated category (dropped) + one valid (kept).
	llm := &stubLLM{responses: []stubResp{{content: `{"findings":[
		{"category":"mind_control","severity":"high","confidence":0.99,"rationale":"invented"},
		{"category":"data_egress","severity":"medium","confidence":0.6,"rationale":"read then send"}
	]}`}}}
	c := NewLLMClassifier(llm, 2000, &LLMMetrics{})
	a, err := c.Classify(context.Background(), AgentBehavior{AgentID: "a1", RunID: "r1"})
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if len(a.Findings) != 1 || a.Findings[0].Category != "data_egress" {
		t.Fatalf("invalid category must be dropped, got %+v", a.Findings)
	}
}

func TestLLMClassifierRejectsOutOfRangeConfidence(t *testing.T) {
	llm := &stubLLM{responses: []stubResp{{content: `{"findings":[
		{"category":"data_egress","severity":"high","confidence":1.5,"rationale":"over range"},
		{"category":"anomalous_sequence","severity":"low","confidence":-0.2,"rationale":"under range"}
	]}`}}}
	c := NewLLMClassifier(llm, 2000, &LLMMetrics{})
	a, err := c.Classify(context.Background(), AgentBehavior{AgentID: "a1", RunID: "r1"})
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if len(a.Findings) != 0 {
		t.Fatalf("out-of-range confidence must be dropped, got %+v", a.Findings)
	}
}

func TestLLMClassifierNormalizesBadSeverity(t *testing.T) {
	llm := &stubLLM{responses: []stubResp{{content: `{"findings":[{"category":"data_egress","severity":"catastrophic","confidence":0.7,"rationale":"x"}]}`}}}
	c := NewLLMClassifier(llm, 2000, &LLMMetrics{})
	a, _ := c.Classify(context.Background(), AgentBehavior{AgentID: "a1", RunID: "r1"})
	if len(a.Findings) != 1 || a.Findings[0].Severity != "low" {
		t.Fatalf("unknown severity must normalize to low, got %+v", a.Findings)
	}
}

func TestLLMClassifierTransportErrorSurfaces(t *testing.T) {
	llm := &stubLLM{responses: []stubResp{{err: errors.New("connection refused")}}}
	m := &LLMMetrics{}
	c := NewLLMClassifier(llm, 2000, m)
	_, err := c.Classify(context.Background(), AgentBehavior{AgentID: "a1", RunID: "r1"})
	if err == nil {
		t.Fatal("transport error must surface so the engine logs/counts it")
	}
	// No content-level retry on transport error → single call, no fallback bookkeeping.
	if llm.calls != 1 {
		t.Errorf("transport error should not trigger a content retry, calls = %d", llm.calls)
	}
	if m.Fallbacks.Load() != 0 {
		t.Errorf("transport error is not a fallback")
	}
}

func TestLLMClassifierExtractsFencedJSON(t *testing.T) {
	llm := &stubLLM{responses: []stubResp{{content: "```json\n{\"findings\":[{\"category\":\"none\",\"severity\":\"low\",\"confidence\":0.1,\"rationale\":\"benign\"}]}\n```"}}}
	c := NewLLMClassifier(llm, 2000, &LLMMetrics{})
	a, err := c.Classify(context.Background(), AgentBehavior{AgentID: "a1", RunID: "r1"})
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if len(a.Findings) != 1 || a.Findings[0].Category != "none" {
		t.Fatalf("fenced JSON should parse, got %+v", a.Findings)
	}
}

func TestExtractJSONObjectBalances(t *testing.T) {
	in := `prefix {"a":{"b":"}"},"c":1} trailing`
	got := extractJSONObject(in)
	if got != `{"a":{"b":"}"},"c":1}` {
		t.Errorf("extractJSONObject = %q", got)
	}
	if extractJSONObject("no object here") != "" {
		t.Errorf("expected empty for no object")
	}
}
