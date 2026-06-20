package main

import (
	"fmt"
	"os"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

// Validator enforces the canonical event contract at the ingest boundary
// (CLAUDE.md rule 5). llm_call events are validated against the formal JSON
// Schema; other SDK event kinds (agent_run, outcome, tool_call) get a minimal
// envelope check pending their own schemas — only llm_call is canonical in
// Phase 1. Unknown kinds are rejected.
type Validator struct {
	llmCall *jsonschema.Schema
}

// NewValidator compiles the llm_call schema from path. The file is read and
// registered as a resource (rather than resolved as a URL) so the loader is
// filesystem- and OS-path agnostic. Format assertions are enabled so the
// "date-time" constraint on ts is enforced.
func NewValidator(path string) (*Validator, error) {
	f, err := os.Open(path) //nolint:gosec // path is operator-provided config, not user input
	if err != nil {
		return nil, fmt.Errorf("open event schema %s: %w", path, err)
	}
	defer func() { _ = f.Close() }()

	c := jsonschema.NewCompiler()
	c.AssertFormat = true
	const id = "https://agentledger.ai/schemas/events/llm_call.schema.json"
	if err := c.AddResource(id, f); err != nil {
		return nil, fmt.Errorf("parse event schema %s: %w", path, err)
	}
	sch, err := c.Compile(id)
	if err != nil {
		return nil, fmt.Errorf("compile event schema %s: %w", path, err)
	}
	return &Validator{llmCall: sch}, nil
}

// Validate checks a decoded event. It returns the event kind (for routing /
// metrics) and a validation error, if any.
func (v *Validator) Validate(ev map[string]any) (kind string, err error) {
	kind, _ = ev["kind"].(string)
	switch kind {
	case "", "llm_call":
		if err := v.llmCall.Validate(ev); err != nil {
			return "llm_call", fmt.Errorf("schema: %w", err)
		}
		return "llm_call", nil
	case "agent_run", "outcome", "tool_call":
		// Envelope-only check until these kinds get formal schemas.
		if s, ok := ev["tenant_id"].(string); !ok || s == "" {
			return kind, fmt.Errorf("missing tenant_id")
		}
		if s, ok := ev["ts"].(string); !ok || s == "" {
			return kind, fmt.Errorf("missing ts")
		}
		return kind, nil
	default:
		return kind, fmt.Errorf("unknown event kind %q", kind)
	}
}

// tenantOf extracts the tenant id used as the Kafka partition key, so all
// events for a tenant land on one partition (ordered, dedup-aligned).
func tenantOf(ev map[string]any) string {
	if s, ok := ev["tenant_id"].(string); ok {
		return s
	}
	return ""
}
