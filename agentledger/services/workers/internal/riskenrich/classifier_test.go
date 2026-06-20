package riskenrich

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAnthropicClassifierParsesAssessment(t *testing.T) {
	var gotReq anthropicReq
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Errorf("path = %q, want /v1/messages", r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "sk-test" {
			t.Errorf("missing/incorrect x-api-key header")
		}
		if r.Header.Get("anthropic-version") == "" {
			t.Errorf("missing anthropic-version header")
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotReq)
		// Respond with a Messages API shape whose text block is the JSON assessment.
		_, _ = w.Write([]byte(`{"stop_reason":"end_turn","content":[{"type":"text","text":"{\"findings\":[{\"category\":\"data_egress\",\"severity\":\"high\",\"confidence\":0.88,\"rationale\":\"read then external send\"}]}"}]}`))
	}))
	defer srv.Close()

	c := NewAnthropicClassifier("sk-test", "claude-opus-4-8", srv.URL)
	a, err := c.Classify(context.Background(), AgentBehavior{
		AgentID: "a1", RunID: "r1", Tools: []string{"read_file", "http_post"}, CallCount: 2,
	})
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if len(a.Findings) != 1 || a.Findings[0].Category != "data_egress" || a.Findings[0].Confidence != 0.88 {
		t.Fatalf("unexpected assessment: %+v", a)
	}
	// Request must carry the model and the structured-output config.
	if gotReq.Model != "claude-opus-4-8" {
		t.Errorf("model = %q, want claude-opus-4-8", gotReq.Model)
	}
	if gotReq.OutputConfig == nil || gotReq.OutputConfig.Format.Type != "json_schema" {
		t.Errorf("expected output_config.format json_schema, got %+v", gotReq.OutputConfig)
	}
}

func TestAnthropicClassifierHandlesRefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"stop_reason":"refusal","content":[]}`))
	}))
	defer srv.Close()

	c := NewAnthropicClassifier("sk-test", "", srv.URL)
	a, err := c.Classify(context.Background(), AgentBehavior{AgentID: "a1", RunID: "r1"})
	if err != nil {
		t.Fatalf("refusal should not error: %v", err)
	}
	if len(a.Findings) != 0 {
		t.Fatalf("refusal should yield no findings, got %+v", a)
	}
}

func TestAnthropicClassifierDefaultsModel(t *testing.T) {
	c := NewAnthropicClassifier("sk-test", "", "")
	if c.model != "claude-opus-4-8" {
		t.Errorf("default model = %q, want claude-opus-4-8", c.model)
	}
	if c.baseURL != "https://api.anthropic.com" {
		t.Errorf("default baseURL = %q", c.baseURL)
	}
}
