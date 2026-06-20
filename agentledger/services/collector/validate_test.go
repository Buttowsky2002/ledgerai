package main

import "testing"

func TestValidatorAcceptsGatewayEvent(t *testing.T) {
	v, err := NewValidator(schemaPath)
	if err != nil {
		t.Fatal(err)
	}
	// A gateway event carries no "kind" and the full attribution + risk set.
	ev := map[string]any{
		"call_id": "call_1", "ts": "2026-06-16T12:00:00.123Z", "tenant_id": "t1",
		"team_id": "eng", "user_id": "u1", "app_id": "app1", "environment": "prod",
		"virtual_key_id": "vk_hash", "provider": "anthropic",
		"request_model": "claude-3-5-sonnet", "response_model": "claude-3-5-sonnet-20241022",
		"operation_name": "chat", "input_tokens": 100, "output_tokens": 50,
		"cache_read_tokens": 20, "cache_write_tokens": 0, "cost_usd": 0.0042,
		"latency_ms": 850, "status_code": 200, "status": "ok",
		"prompt_hash": "deadbeef", "dlp_action": "redact", "risk_severity": "high",
		"dlp_findings": []any{
			map[string]any{"class": "credit_card", "category": "pci", "severity": "critical", "confidence": 0.85, "count": 1},
		},
		"streamed": true, "source": "gateway",
	}
	kind, err := v.Validate(ev)
	if err != nil {
		t.Fatalf("valid gateway event rejected: %v", err)
	}
	if kind != "llm_call" {
		t.Fatalf("kind = %q, want llm_call", kind)
	}
}

func TestValidatorAcceptsSDKEvent(t *testing.T) {
	v, _ := NewValidator(schemaPath)
	// The SDK record_llm_call payload: explicit kind + source, sparse fields.
	ev := map[string]any{
		"kind": "llm_call", "call_id": "call_x", "ts": "2026-06-16T12:00:00Z",
		"tenant_id": "t1", "app_id": "app1", "user_id": "u1", "environment": "prod",
		"agent_id": "triage", "run_id": "run_1", "step_id": "step_2",
		"provider": "openai", "request_model": "gpt-4o", "operation_name": "chat",
		"input_tokens": 10, "output_tokens": 5, "cache_read_tokens": 0,
		"cost_usd": 0.001, "latency_ms": 200, "status": "ok", "source": "sdk",
	}
	if _, err := v.Validate(ev); err != nil {
		t.Fatalf("valid SDK event rejected: %v", err)
	}
}

func TestValidatorRejectsAdditionalProperties(t *testing.T) {
	v, _ := NewValidator(schemaPath)
	ev := map[string]any{
		"call_id": "c1", "ts": "2026-06-16T12:00:00Z", "tenant_id": "t1",
		"completion": "raw model output that must never be stored",
	}
	if _, err := v.Validate(ev); err == nil {
		t.Fatal("event with unknown field must be rejected (no raw content allowed)")
	}
}

func TestValidatorAcceptsToolCall(t *testing.T) {
	v, _ := NewValidator(schemaPath)
	ev := map[string]any{
		"kind": "tool_call", "ts": "2026-06-16T12:00:00Z", "tenant_id": "t1",
		"agent_id": "triage", "run_id": "run_1",
		"tool_call_id": "tool_abc123", "tool_name": "shell.exec",
		"operation_name": "execute_tool", "source": "sdk",
	}
	kind, err := v.Validate(ev)
	if err != nil {
		t.Fatalf("valid tool_call rejected: %v", err)
	}
	if kind != "tool_call" {
		t.Fatalf("kind = %q, want tool_call", kind)
	}
}

func TestValidatorRejectsToolCallMissingDedupKey(t *testing.T) {
	v, _ := NewValidator(schemaPath)
	// Without tool_call_id, agent_tool_calls' ReplacingMergeTree would collapse
	// every tool call for an agent into a single row.
	ev := map[string]any{
		"kind": "tool_call", "ts": "2026-06-16T12:00:00Z", "tenant_id": "t1",
		"agent_id": "triage", "tool_name": "shell.exec",
	}
	if _, err := v.Validate(ev); err == nil {
		t.Fatal("tool_call without tool_call_id must be rejected")
	}
}

func TestValidatorRejectsToolCallMissingToolName(t *testing.T) {
	v, _ := NewValidator(schemaPath)
	ev := map[string]any{
		"kind": "tool_call", "ts": "2026-06-16T12:00:00Z", "tenant_id": "t1",
		"agent_id": "triage", "tool_call_id": "tool_abc123",
	}
	if _, err := v.Validate(ev); err == nil {
		t.Fatal("tool_call without tool_name must be rejected")
	}
}

func TestValidatorRejectsNegativeTokens(t *testing.T) {
	v, _ := NewValidator(schemaPath)
	ev := map[string]any{
		"call_id": "c1", "ts": "2026-06-16T12:00:00Z", "tenant_id": "t1",
		"input_tokens": -5,
	}
	if _, err := v.Validate(ev); err == nil {
		t.Fatal("negative token count must be rejected")
	}
}
