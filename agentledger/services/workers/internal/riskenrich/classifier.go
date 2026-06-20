// Package riskenrich is the semantic risk-enrichment worker (Phase 6, the
// deferred P5 semantic tier). It reads per-run tool/MCP call *sequences* from
// agent_tool_calls (metadata only — never prompt/completion content, CLAUDE.md
// rule 2), asks an LLM to classify behavioral risk the deterministic tier can't
// (suspected injection, data egress, anomalous tool sequences), and writes the
// findings as governed risk_events alongside the deterministic tier.
//
//	agent_tool_calls (sequences) ─▶ [risk-enrichment] ─▶ risk_events (category: semantic_*)
//
// The LLM call is async and opt-in (never on any inline path), gated on the
// deterministic tier per ADR-027. The Anthropic Messages API is reached over
// stdlib net/http to stay consistent with the rest of the workers/connectors
// (no vendor SDK; CLAUDE.md rule 12). See ADR-030.
package riskenrich

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Finding is one semantic risk the classifier attributes to a run's behavior.
type Finding struct {
	Category   string  `json:"category"`   // injection_suspected | data_egress | privilege_escalation | anomalous_sequence | none
	Severity   string  `json:"severity"`   // low | medium | high
	Confidence float64 `json:"confidence"` // 0..1
	Rationale  string  `json:"rationale"`  // reasoning over the tool-call pattern (no raw content)
}

// Assessment is the classifier's verdict for one AgentBehavior.
type Assessment struct {
	Findings []Finding `json:"findings"`
}

// Classifier turns an observed behavior into a semantic risk assessment.
// Abstracted so the Engine is unit-testable without a live LLM.
type Classifier interface {
	Classify(ctx context.Context, b AgentBehavior) (Assessment, error)
}

// classifierSystemPrompt instructs the model to reason over tool-call metadata
// only. It must never request or infer prompt/completion content (none is
// available) — only the sequence, MCP servers, and counts.
const classifierSystemPrompt = `You are a security classifier for an agent FinOps & risk control plane.
You are given METADATA about one AI agent run: the ordered sequence of tool/MCP
calls it made, the MCP servers involved, and the call count. You never see prompt
or completion content — reason only about the behavioral pattern.

Classify whether the sequence suggests any of these risks:
- injection_suspected: the tool sequence suggests an injected instruction drove an
  unintended action (e.g. reading untrusted input then immediately exfiltrating).
- data_egress: a read/collect of sensitive data followed by an external send.
- privilege_escalation: acquiring or using higher-privilege tools mid-run.
- anomalous_sequence: an order or combination of tools that is unusual or unsafe.

Return findings ONLY for genuine concerns. If the behavior is benign, return an
empty findings array (or a single finding with category "none"). Set confidence
in 0..1 reflecting how strongly the metadata supports the finding; be conservative.
Keep each rationale to one sentence about the pattern — never invent content.`

// assessmentSchema is the JSON Schema the Messages API constrains output to.
// Structured outputs require additionalProperties:false and explicit required.
func assessmentSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"findings": map[string]any{
				"type": "array",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"category": map[string]any{
							"type": "string",
							"enum": []string{
								"injection_suspected", "data_egress",
								"privilege_escalation", "anomalous_sequence", "none",
							},
						},
						"severity":   map[string]any{"type": "string", "enum": []string{"low", "medium", "high"}},
						"confidence": map[string]any{"type": "number"},
						"rationale":  map[string]any{"type": "string"},
					},
					"required":             []string{"category", "severity", "confidence", "rationale"},
					"additionalProperties": false,
				},
			},
		},
		"required":             []string{"findings"},
		"additionalProperties": false,
	}
}

// AnthropicClassifier calls the Anthropic Messages API over stdlib HTTP.
type AnthropicClassifier struct {
	apiKey  string
	model   string
	baseURL string
	version string
	client  *http.Client
}

// NewAnthropicClassifier builds a classifier. model defaults to claude-opus-4-8
// when empty; baseURL defaults to the public API. The API key is read from the
// caller (operator env) and never logged.
func NewAnthropicClassifier(apiKey, model, baseURL string) *AnthropicClassifier {
	if model == "" {
		model = "claude-opus-4-8"
	}
	if baseURL == "" {
		baseURL = "https://api.anthropic.com"
	}
	return &AnthropicClassifier{
		apiKey:  apiKey,
		model:   model,
		baseURL: strings.TrimRight(baseURL, "/"),
		version: "2023-06-01",
		client:  &http.Client{Timeout: 60 * time.Second},
	}
}

type anthropicReq struct {
	Model        string         `json:"model"`
	MaxTokens    int            `json:"max_tokens"`
	System       string         `json:"system,omitempty"`
	Messages     []anthropicMsg `json:"messages"`
	OutputConfig *outputConfig  `json:"output_config,omitempty"`
}

type anthropicMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type outputConfig struct {
	Format jsonFormat `json:"format"`
}

type jsonFormat struct {
	Type   string         `json:"type"`
	Schema map[string]any `json:"schema"`
}

type anthropicResp struct {
	StopReason string `json:"stop_reason"`
	Content    []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

// Classify sends one behavior's metadata to the model and parses the verdict.
// A safety refusal yields an empty Assessment (the run is simply not enriched),
// never an error that would stall the pass.
func (c *AnthropicClassifier) Classify(ctx context.Context, b AgentBehavior) (Assessment, error) {
	reqBody := anthropicReq{
		Model:     c.model,
		MaxTokens: 1024,
		System:    classifierSystemPrompt,
		Messages:  []anthropicMsg{{Role: "user", Content: behaviorPrompt(b)}},
		OutputConfig: &outputConfig{Format: jsonFormat{
			Type:   "json_schema",
			Schema: assessmentSchema(),
		}},
	}
	buf, err := json.Marshal(reqBody)
	if err != nil {
		return Assessment{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/messages", bytes.NewReader(buf))
	if err != nil {
		return Assessment{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("anthropic-version", c.version)

	resp, err := c.client.Do(req)
	if err != nil {
		return Assessment{}, fmt.Errorf("anthropic request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return Assessment{}, fmt.Errorf("anthropic status %d: %s", resp.StatusCode, bytes.TrimSpace(body))
	}

	var ar anthropicResp
	if err := json.Unmarshal(body, &ar); err != nil {
		return Assessment{}, fmt.Errorf("anthropic decode: %w", err)
	}
	if ar.StopReason == "refusal" {
		// Safety classifier declined; skip enrichment for this run.
		return Assessment{}, nil
	}

	// With output_config.format, the first text block is valid JSON.
	for _, blk := range ar.Content {
		if blk.Type == "text" && strings.TrimSpace(blk.Text) != "" {
			var a Assessment
			if err := json.Unmarshal([]byte(blk.Text), &a); err != nil {
				return Assessment{}, fmt.Errorf("assessment decode: %w", err)
			}
			return a, nil
		}
	}
	return Assessment{}, nil
}

// behaviorPrompt renders a behavior as the user message — metadata only.
func behaviorPrompt(b AgentBehavior) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "agent_id: %s\nrun_id: %s\ntotal_tool_calls: %d\n", b.AgentID, b.RunID, b.CallCount)
	if len(b.MCPServers) > 0 {
		fmt.Fprintf(&sb, "mcp_servers: %s\n", strings.Join(b.MCPServers, ", "))
	}
	fmt.Fprintf(&sb, "tool_call_sequence: %s\n", strings.Join(b.Tools, " -> "))
	return sb.String()
}
