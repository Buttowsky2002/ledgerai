package riskenrich

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// ChatRequest is one provider-agnostic chat completion. JSONSchema, when set,
// constrains the model's output to that schema (best-effort — servers that
// ignore it still work because the caller re-validates the parsed JSON).
type ChatRequest struct {
	System      string
	User        string
	JSONSchema  map[string]any // optional structured-output constraint
	SchemaName  string         // label sent with the schema (cosmetic)
	MaxTokens   int
	Temperature float64
}

// ChatResponse is the content plus token accounting (tokens are 0 when the
// server does not report usage). Content is the raw assistant message text.
type ChatResponse struct {
	Content          string
	PromptTokens     int
	CompletionTokens int
}

// LLMChatClient is the single seam between the classifier and the model server.
// It is provider-agnostic: any OpenAI-compatible endpoint (vLLM, Ollama,
// llama.cpp server, TGI) satisfies it. Abstracted so the classifier is testable
// against a stub without a live model.
type LLMChatClient interface {
	Chat(ctx context.Context, req ChatRequest) (ChatResponse, error)
}

// LLMMetrics holds aggregate counters for the LLM path. It records latency,
// request/retry/failure counts, malformed/fallback counts, and token usage —
// never any request or response body (CLAUDE.md rule 2 / ADR-050).
type LLMMetrics struct {
	Requests         atomic.Int64 // logical Chat calls attempted
	Retries          atomic.Int64 // extra HTTP attempts after the first (5xx/timeout)
	Failures         atomic.Int64 // Chat calls that returned an error after all attempts
	Malformed        atomic.Int64 // 200 responses whose content failed parse/validate (triggered a retry)
	Fallbacks        atomic.Int64 // classifications that fell back to empty after retry
	PromptTokens     atomic.Int64
	CompletionTokens atomic.Int64
	LatencyMsTotal   atomic.Int64
}

// OpenAICompatibleClient POSTs to {baseURL}/v1/chat/completions using stdlib
// net/http only (no vendor SDK; CLAUDE.md rule 12). It targets our own
// self-hosted model server and never egresses to a third-party AI API.
type OpenAICompatibleClient struct {
	baseURL    string
	model      string
	apiKey     string // optional bearer for a gateway in front of the model
	client     *http.Client
	metrics    *LLMMetrics
	maxRetries int
	baseDelay  time.Duration
	sleep      func(time.Duration) // injectable for tests
}

// NewOpenAICompatibleClient builds a client. baseURL defaults to
// http://localhost:8000 and model to badger-ai-8b when empty; timeout defaults
// to 60s. apiKey is optional (sent as a bearer only when non-empty).
func NewOpenAICompatibleClient(baseURL, model, apiKey string, timeout time.Duration, m *LLMMetrics) *OpenAICompatibleClient {
	if baseURL == "" {
		baseURL = "http://localhost:8000"
	}
	if model == "" {
		model = "badger-ai-8b"
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	if m == nil {
		m = &LLMMetrics{}
	}
	return &OpenAICompatibleClient{
		baseURL:    strings.TrimRight(baseURL, "/"),
		model:      model,
		apiKey:     apiKey,
		client:     &http.Client{Timeout: timeout},
		metrics:    m,
		maxRetries: 2,
		baseDelay:  200 * time.Millisecond,
		sleep:      time.Sleep,
	}
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type jsonSchemaSpec struct {
	Name   string         `json:"name"`
	Schema map[string]any `json:"schema"`
	Strict bool           `json:"strict"`
}

type responseFormat struct {
	Type       string          `json:"type"`
	JSONSchema *jsonSchemaSpec `json:"json_schema,omitempty"`
}

type chatCompletionsReq struct {
	Model          string          `json:"model"`
	Messages       []chatMessage   `json:"messages"`
	MaxTokens      int             `json:"max_tokens,omitempty"`
	Temperature    float64         `json:"temperature"`
	ResponseFormat *responseFormat `json:"response_format,omitempty"`
	// GuidedJSON is a vLLM extension read from the request body; other servers
	// ignore it. Sent only alongside response_format so a strict server that
	// rejects unknown fields is only exercised when we intend structured output.
	GuidedJSON map[string]any `json:"guided_json,omitempty"`
}

type chatCompletionsResp struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

// Chat sends one completion, retrying on 5xx/timeout with exponential backoff.
// Request and response bodies are never logged; errors carry status/attempt
// context only (never a body), so callers can log them safely.
func (c *OpenAICompatibleClient) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	c.metrics.Requests.Add(1)
	start := time.Now()
	defer func() { c.metrics.LatencyMsTotal.Add(time.Since(start).Milliseconds()) }()

	body := chatCompletionsReq{
		Model: c.model,
		Messages: []chatMessage{
			{Role: "system", Content: req.System},
			{Role: "user", Content: req.User},
		},
		MaxTokens:   req.MaxTokens,
		Temperature: req.Temperature,
	}
	if req.JSONSchema != nil {
		name := req.SchemaName
		if name == "" {
			name = "response"
		}
		body.ResponseFormat = &responseFormat{
			Type:       "json_schema",
			JSONSchema: &jsonSchemaSpec{Name: name, Schema: req.JSONSchema, Strict: true},
		}
		body.GuidedJSON = req.JSONSchema
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return ChatResponse{}, err
	}

	var lastErr error
	for attempt := 0; attempt <= c.maxRetries; attempt++ {
		if attempt > 0 {
			c.metrics.Retries.Add(1)
			if ctx.Err() != nil {
				c.metrics.Failures.Add(1)
				return ChatResponse{}, ctx.Err()
			}
			c.sleep(c.backoff(attempt))
		}
		resp, retryable, err := c.do(ctx, buf)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if !retryable {
			break
		}
	}
	c.metrics.Failures.Add(1)
	return ChatResponse{}, lastErr
}

// do performs a single attempt. The bool reports whether the error is worth
// retrying (transport error / 5xx). No response body is ever included in the
// returned error.
func (c *OpenAICompatibleClient) do(ctx context.Context, buf []byte) (ChatResponse, bool, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/chat/completions", bytes.NewReader(buf))
	if err != nil {
		return ChatResponse{}, false, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.client.Do(httpReq)
	if err != nil {
		// Transport-level errors (including timeouts) are retryable.
		return ChatResponse{}, true, fmt.Errorf("llm request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode >= 500 {
		return ChatResponse{}, true, fmt.Errorf("llm status %d", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return ChatResponse{}, false, fmt.Errorf("llm status %d", resp.StatusCode)
	}

	var cr chatCompletionsResp
	if err := json.Unmarshal(raw, &cr); err != nil {
		// A 200 with an undecodable envelope is not worth retrying at the
		// transport layer; the classifier handles content-level malformation.
		return ChatResponse{}, false, fmt.Errorf("llm decode envelope: %w", err)
	}
	c.metrics.PromptTokens.Add(int64(cr.Usage.PromptTokens))
	c.metrics.CompletionTokens.Add(int64(cr.Usage.CompletionTokens))
	var content string
	if len(cr.Choices) > 0 {
		content = cr.Choices[0].Message.Content
	}
	return ChatResponse{
		Content:          content,
		PromptTokens:     cr.Usage.PromptTokens,
		CompletionTokens: cr.Usage.CompletionTokens,
	}, false, nil
}

// backoff returns an exponential delay for the given attempt (1-based retry).
func (c *OpenAICompatibleClient) backoff(attempt int) time.Duration {
	d := c.baseDelay
	for i := 1; i < attempt; i++ {
		d *= 2
	}
	return d
}
