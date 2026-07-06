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
// deterministic tier per ADR-027. Inference runs against BadgerIQ's own
// self-hosted model over an OpenAI-compatible endpoint (stdlib net/http, no
// vendor SDK; CLAUDE.md rule 12) — no external AI API is ever called. See
// ADR-030 (original tier) and ADR-050 (self-hosted pivot).
package riskenrich

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
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

// validCategories / validSeverities bound what a (possibly small, self-hosted)
// model is allowed to emit. Anything outside these sets is dropped rather than
// trusted — the guardrail matters MORE with a smaller model, not less.
var validCategories = map[string]bool{
	"injection_suspected":  true,
	"data_egress":          true,
	"privilege_escalation": true,
	"anomalous_sequence":   true,
	"none":                 true,
}

var validSeverities = map[string]bool{"low": true, "medium": true, "high": true}

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
  Also consider tool_result-sourced injection: a read from an untrusted MCP server
  immediately followed by an exfiltration-shaped call suggests malicious MCP output
  drove the run — reason over the sequence metadata, never invent prompt content.
- data_egress: a read/collect of sensitive data followed by an external send.
- privilege_escalation: acquiring or using higher-privilege tools mid-run.
- anomalous_sequence: an order or combination of tools that is unusual or unsafe.

Return findings ONLY for genuine concerns. If the behavior is benign, return an
empty findings array (or a single finding with category "none"). Set confidence
in 0..1 reflecting how strongly the metadata supports the finding; be conservative.
Keep each rationale to one sentence about the pattern — never invent content.
Respond with ONLY a JSON object matching the schema: {"findings":[...]}.`

// assessmentSchema is the JSON Schema output is constrained to. Structured
// outputs require additionalProperties:false and explicit required.
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

// LLMClassifier classifies a behavior by asking a self-hosted model over an
// OpenAI-compatible endpoint, then re-validating the output. Guardrails, in
// order: (1) metadata-only prompt, (2) JSON-schema-constrained request,
// (3) tolerant JSON extraction, (4) post-parse validation against the allowed
// category/severity/confidence sets, (5) retry-then-deterministic-fallback
// (malformed → one retry → empty assessment, so the deterministic tier stays
// authoritative and a bad model output never fabricates a risk_event).
type LLMClassifier struct {
	llm       LLMChatClient
	maxTokens int
	metrics   *LLMMetrics
}

// NewLLMClassifier wires a classifier over any LLMChatClient. maxTokens
// defaults to 2000 when non-positive.
func NewLLMClassifier(llm LLMChatClient, maxTokens int, m *LLMMetrics) *LLMClassifier {
	if maxTokens <= 0 {
		maxTokens = 2000
	}
	if m == nil {
		m = &LLMMetrics{}
	}
	return &LLMClassifier{llm: llm, maxTokens: maxTokens, metrics: m}
}

// Classify sends one behavior's metadata to the model and returns a validated
// assessment. A transport failure is surfaced as an error (the engine logs and
// skips the run). A 200 whose content will not parse/validate is retried once,
// then falls back to an empty assessment rather than inventing findings.
func (c *LLMClassifier) Classify(ctx context.Context, b AgentBehavior) (Assessment, error) {
	req := ChatRequest{
		System:      classifierSystemPrompt,
		User:        behaviorPrompt(b),
		JSONSchema:  assessmentSchema(),
		SchemaName:  "risk_assessment",
		MaxTokens:   c.maxTokens,
		Temperature: 0.2,
	}

	resp, err := c.llm.Chat(ctx, req)
	if err != nil {
		return Assessment{}, err
	}
	if a, ok := parseAssessment(resp.Content); ok {
		return a, nil
	}

	// 200 but unparseable/invalid → one retry (a smaller model occasionally
	// wraps or truncates JSON), then deterministic fallback.
	c.metrics.Malformed.Add(1)
	resp, err = c.llm.Chat(ctx, req)
	if err != nil {
		return Assessment{}, err
	}
	if a, ok := parseAssessment(resp.Content); ok {
		return a, nil
	}
	c.metrics.Fallbacks.Add(1)
	return Assessment{}, nil
}

// parseAssessment extracts JSON from possibly-decorated model output, unmarshals
// it, and validates every finding. It returns ok=false if nothing parseable is
// found — never an assessment built from invalid findings.
func parseAssessment(content string) (Assessment, bool) {
	raw := extractJSONObject(content)
	if raw == "" {
		return Assessment{}, false
	}
	var a Assessment
	if err := json.Unmarshal([]byte(raw), &a); err != nil {
		return Assessment{}, false
	}
	return validateAssessment(a), true
}

// validateAssessment drops any finding outside the allowed category/confidence
// bounds and normalizes severity, so a hallucinated category or out-of-range
// score can never reach risk_events.
func validateAssessment(a Assessment) Assessment {
	kept := make([]Finding, 0, len(a.Findings))
	for _, f := range a.Findings {
		if !validCategories[f.Category] {
			continue
		}
		if f.Confidence < 0 || f.Confidence > 1 {
			continue
		}
		if !validSeverities[f.Severity] {
			f.Severity = "low"
		}
		kept = append(kept, f)
	}
	return Assessment{Findings: kept}
}

// extractJSONObject returns the first balanced top-level JSON object in s,
// tolerating code fences or prose around it. Empty string if none is found.
func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return ""
	}
	depth := 0
	inStr := false
	esc := false
	for i := start; i < len(s); i++ {
		ch := s[i]
		if inStr {
			switch {
			case esc:
				esc = false
			case ch == '\\':
				esc = true
			case ch == '"':
				inStr = false
			}
			continue
		}
		switch ch {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return ""
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
