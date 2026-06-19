package litellm

import (
	"encoding/json"
	"testing"
)

const defaultCfgTenant = "t_default"

func cfg() Config {
	return Config{DefaultTenant: defaultCfgTenant, TenantMetaKey: "agentledger_tenant_id"}
}

// A StandardLoggingPayload-style record: cost under response_cost, unix-seconds
// float timestamps, tenant via metadata override.
func TestNormalizeStandardLoggingPayload(t *testing.T) {
	raw := `{
      "id": "abc-123",
      "call_type": "acompletion",
      "api_key": "hashed_key_xyz",
      "response_cost": 0.0042,
      "prompt_tokens": 120,
      "completion_tokens": 35,
      "cache_read_input_tokens": 20,
      "startTime": 1718800000.0,
      "endTime": 1718800001.5,
      "model": "gpt-4o",
      "custom_llm_provider": "openai",
      "end_user": "alice@acme.test",
      "status": "success",
      "metadata": {
        "agentledger_tenant_id": "t_acme",
        "user_api_key_team_id": "team_7",
        "user_api_key_alias": "support-bot"
      }
    }`
	var rec SpendLog
	if err := json.Unmarshal([]byte(raw), &rec); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	ev, err := Normalize(rec, cfg())
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}

	want := map[string]any{
		"kind": "llm_call", "call_id": "litellm:abc-123", "tenant_id": "t_acme",
		"source": "adapter", "provider": "openai", "request_model": "gpt-4o",
		"operation_name": "acompletion", "status": "ok",
		"user_id": "alice@acme.test", "team_id": "team_7", "app_id": "support-bot",
		"virtual_key_id": "hashed_key_xyz",
	}
	for k, v := range want {
		if ev[k] != v {
			t.Errorf("%s = %v, want %v", k, ev[k], v)
		}
	}
	if ev["cost_usd"] != 0.0042 {
		t.Errorf("cost_usd = %v, want 0.0042", ev["cost_usd"])
	}
	if ev["input_tokens"] != int64(120) || ev["output_tokens"] != int64(35) {
		t.Errorf("tokens = %v/%v, want 120/35", ev["input_tokens"], ev["output_tokens"])
	}
	if ev["cache_read_tokens"] != int64(20) {
		t.Errorf("cache_read_tokens = %v, want 20", ev["cache_read_tokens"])
	}
	if ev["latency_ms"] != int64(1500) {
		t.Errorf("latency_ms = %v, want 1500", ev["latency_ms"])
	}
	if ev["ts"] != "2024-06-19T12:26:40Z" {
		t.Errorf("ts = %v, want 2024-06-19T12:26:40Z", ev["ts"])
	}
}

// A /spend/logs row: cost under spend, ISO-string timestamps, no metadata
// tenant → falls back to the configured default tenant.
func TestNormalizeSpendLogsRow(t *testing.T) {
	raw := `{
      "request_id": "req-9",
      "spend": 0.01,
      "prompt_tokens": 5,
      "completion_tokens": 2,
      "startTime": "2026-06-19T12:00:00Z",
      "endTime": "2026-06-19T12:00:00.250Z",
      "model": "claude-3-5-sonnet",
      "custom_llm_provider": "anthropic"
    }`
	var rec SpendLog
	_ = json.Unmarshal([]byte(raw), &rec)
	ev, err := Normalize(rec, cfg())
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if ev["call_id"] != "litellm:req-9" {
		t.Errorf("call_id = %v", ev["call_id"])
	}
	if ev["tenant_id"] != defaultCfgTenant {
		t.Errorf("tenant_id = %v, want default %s", ev["tenant_id"], defaultCfgTenant)
	}
	if ev["cost_usd"] != 0.01 {
		t.Errorf("cost_usd = %v, want 0.01", ev["cost_usd"])
	}
	if ev["latency_ms"] != int64(250) {
		t.Errorf("latency_ms = %v, want 250", ev["latency_ms"])
	}
}

func TestNormalizeRejectsMissingID(t *testing.T) {
	var rec SpendLog
	_ = json.Unmarshal([]byte(`{"startTime":1718800000.0}`), &rec)
	if _, err := Normalize(rec, cfg()); err == nil {
		t.Fatal("expected error for missing id")
	}
}

func TestNormalizeRejectsMissingStartTime(t *testing.T) {
	var rec SpendLog
	_ = json.Unmarshal([]byte(`{"id":"x"}`), &rec)
	if _, err := Normalize(rec, cfg()); err == nil {
		t.Fatal("expected error for missing startTime")
	}
}

func TestNormalizeRejectsNoTenant(t *testing.T) {
	var rec SpendLog
	_ = json.Unmarshal([]byte(`{"id":"x","startTime":1718800000.0}`), &rec)
	// No default tenant and no metadata override.
	if _, err := Normalize(rec, Config{TenantMetaKey: "agentledger_tenant_id"}); err == nil {
		t.Fatal("expected error when no tenant resolvable")
	}
}

func TestNormalizeFailureStatus(t *testing.T) {
	var rec SpendLog
	_ = json.Unmarshal([]byte(`{"id":"x","startTime":1718800000.0,"status":"failure"}`), &rec)
	ev, err := Normalize(rec, cfg())
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if ev["status"] != "upstream_error" {
		t.Errorf("status = %v, want upstream_error", ev["status"])
	}
}

func TestNormalizeBatchSplitsValidFromInvalid(t *testing.T) {
	raw := `[
      {"id":"ok1","startTime":1718800000.0,"model":"gpt-4o"},
      {"startTime":1718800000.0},
      {"id":"ok2","startTime":1718800000.0}
    ]`
	var recs []SpendLog
	_ = json.Unmarshal([]byte(raw), &recs)
	events, errs := NormalizeBatch(recs, cfg())
	if len(events) != 2 {
		t.Errorf("events = %d, want 2", len(events))
	}
	if len(errs) != 1 {
		t.Errorf("errs = %d, want 1", len(errs))
	}
}

// Absent optional numerics must not appear as misleading zeros.
func TestNormalizeOmitsAbsentFields(t *testing.T) {
	var rec SpendLog
	_ = json.Unmarshal([]byte(`{"id":"x","startTime":1718800000.0}`), &rec)
	ev, err := Normalize(rec, cfg())
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	for _, k := range []string{"cost_usd", "input_tokens", "output_tokens", "provider", "latency_ms"} {
		if _, present := ev[k]; present {
			t.Errorf("%s should be absent when not in the record, got %v", k, ev[k])
		}
	}
}
