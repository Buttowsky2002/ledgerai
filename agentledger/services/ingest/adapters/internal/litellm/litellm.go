// Package litellm normalizes LiteLLM spend/usage log records into BadgerIQ
// canonical llm_call events.
//
// LiteLLM (a popular OSS LLM gateway/proxy) emits a spend log per request —
// either as rows from its /spend/logs API or as the StandardLoggingPayload sent
// to a logging callback/webhook. This package maps the fields we need onto the
// canonical event so a customer already running LiteLLM gets attribution + cost
// in BadgerIQ without routing traffic through our gateway
// (ARCHITECTURE_PIVOT.md, Pillar 1).
//
// SECURITY (CLAUDE.md rule 15): LiteLLM logs are untrusted third-party input. We
// read only the fields we map, never the prompt/response/messages, and the
// canonical event is schema-validated downstream at the collector boundary. We
// reject records missing the fields required for attribution rather than
// inventing values.
//
// Format drift: LiteLLM's payload shape changes across versions. The tolerant
// decoding here (cost under spend|response_cost, timestamps as ISO string or
// unix-seconds float) and the assumptions are documented in
// docs/ADRs/023-litellm-adapter.md and the module README.
package litellm

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Config controls tenant resolution. The adapter is typically deployed per
// customer/tenant, so DefaultTenant is the common case; a per-record override
// via a metadata key supports multi-tenant LiteLLM deployments.
type Config struct {
	DefaultTenant string // applied when a record carries no tenant override
	TenantMetaKey string // metadata key whose value overrides the tenant (e.g. "agentledger_tenant_id")
}

// SpendLog models the subset of a LiteLLM spend-log record we consume. Unknown
// fields are ignored. Pointers distinguish "absent" from a zero value so we
// don't emit misleading zeros.
type SpendLog struct {
	ID                       string         `json:"id"`
	RequestID                string         `json:"request_id"`
	CallType                 string         `json:"call_type"`
	APIKey                   string         `json:"api_key"` // already a hash in LiteLLM
	Spend                    *float64       `json:"spend"`
	ResponseCost             *float64       `json:"response_cost"`
	PromptTokens             *int64         `json:"prompt_tokens"`
	CompletionTokens         *int64         `json:"completion_tokens"`
	CacheReadInputTokens     *int64         `json:"cache_read_input_tokens"`
	CacheCreationInputTokens *int64         `json:"cache_creation_input_tokens"`
	StartTime                flexTime       `json:"startTime"`
	EndTime                  flexTime       `json:"endTime"`
	Model                    string         `json:"model"`
	CustomLLMProvider        string         `json:"custom_llm_provider"`
	User                     string         `json:"user"`
	EndUser                  string         `json:"end_user"`
	Status                   string         `json:"status"`
	Metadata                 map[string]any `json:"metadata"`
}

// Normalize maps one LiteLLM spend-log record to a canonical llm_call event.
// It returns an error (the record is rejected, not silently dropped) when a
// field required for attribution is missing: a stable id, a start time, or a
// resolvable tenant.
func Normalize(rec SpendLog, cfg Config) (map[string]any, error) {
	id := firstNonEmpty(rec.ID, rec.RequestID)
	if id == "" {
		return nil, fmt.Errorf("litellm record missing id/request_id")
	}
	if !rec.StartTime.set {
		return nil, fmt.Errorf("litellm record %q missing startTime", id)
	}
	tenant := resolveTenant(rec.Metadata, cfg)
	if tenant == "" {
		return nil, fmt.Errorf("litellm record %q has no tenant (set AGENTLEDGER_ADAPTER_TENANT or a %q metadata key)", id, cfg.TenantMetaKey)
	}

	ev := map[string]any{
		"kind":      "llm_call",
		"call_id":   "litellm:" + id,
		"ts":        rec.StartTime.t.UTC().Format(time.RFC3339Nano),
		"tenant_id": tenant,
		"source":    "adapter",
		"streamed":  false,
	}
	if rec.CustomLLMProvider != "" {
		ev["provider"] = rec.CustomLLMProvider
	}
	if rec.Model != "" {
		ev["request_model"] = rec.Model
	}
	if rec.CallType != "" {
		ev["operation_name"] = rec.CallType
	}

	// Cost: response_cost (StandardLoggingPayload) or spend (SpendLogs row).
	if cost := firstNonNilFloat(rec.ResponseCost, rec.Spend); cost != nil && *cost >= 0 {
		ev["cost_usd"] = *cost
	}
	if rec.PromptTokens != nil && *rec.PromptTokens >= 0 {
		ev["input_tokens"] = *rec.PromptTokens
	}
	if rec.CompletionTokens != nil && *rec.CompletionTokens >= 0 {
		ev["output_tokens"] = *rec.CompletionTokens
	}
	if rec.CacheReadInputTokens != nil && *rec.CacheReadInputTokens >= 0 {
		ev["cache_read_tokens"] = *rec.CacheReadInputTokens
	}
	if rec.CacheCreationInputTokens != nil && *rec.CacheCreationInputTokens >= 0 {
		ev["cache_write_tokens"] = *rec.CacheCreationInputTokens
	}

	// Latency from the request window.
	if rec.EndTime.set {
		if ms := rec.EndTime.t.Sub(rec.StartTime.t).Milliseconds(); ms >= 0 {
			ev["latency_ms"] = ms
		}
	}
	// Status: LiteLLM uses "success"/"failure"; default to ok when unset.
	if strings.EqualFold(rec.Status, "failure") || strings.EqualFold(rec.Status, "error") {
		ev["status"] = "upstream_error"
	} else {
		ev["status"] = "ok"
	}

	// Attribution dimensions.
	if u := firstNonEmpty(rec.EndUser, rec.User, metaString(rec.Metadata, "user_api_key_user_id")); u != "" {
		ev["user_id"] = u
	}
	if team := metaString(rec.Metadata, "user_api_key_team_id"); team != "" {
		ev["team_id"] = team
	}
	if alias := metaString(rec.Metadata, "user_api_key_alias"); alias != "" {
		ev["app_id"] = alias
	}
	if rec.APIKey != "" {
		ev["virtual_key_id"] = rec.APIKey
	}

	return ev, nil
}

// NormalizeBatch normalizes a slice of records, returning the successfully
// mapped events and the per-record errors (index-aligned to the failures).
func NormalizeBatch(recs []SpendLog, cfg Config) ([]map[string]any, []error) {
	events := make([]map[string]any, 0, len(recs))
	var errs []error
	for i := range recs {
		ev, err := Normalize(recs[i], cfg)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		events = append(events, ev)
	}
	return events, errs
}

func resolveTenant(meta map[string]any, cfg Config) string {
	if cfg.TenantMetaKey != "" {
		if v := metaString(meta, cfg.TenantMetaKey); v != "" {
			return v
		}
	}
	return cfg.DefaultTenant
}

func metaString(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	if v, ok := meta[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func firstNonNilFloat(vals ...*float64) *float64 {
	for _, v := range vals {
		if v != nil {
			return v
		}
	}
	return nil
}

// flexTime accepts a LiteLLM timestamp encoded either as an ISO-8601 string
// (SpendLogs rows) or a unix-seconds float (StandardLoggingPayload).
type flexTime struct {
	t   time.Time
	set bool
}

func (f *flexTime) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		return nil
	}
	if s[0] == '"' {
		var str string
		if err := json.Unmarshal(b, &str); err != nil {
			return err
		}
		if str == "" {
			return nil
		}
		for _, layout := range []string{
			time.RFC3339Nano, time.RFC3339,
			"2006-01-02T15:04:05.999999",
			"2006-01-02T15:04:05",
			"2006-01-02 15:04:05.999999",
			"2006-01-02 15:04:05",
		} {
			if t, err := time.Parse(layout, str); err == nil {
				f.t, f.set = t.UTC(), true
				return nil
			}
		}
		return fmt.Errorf("unrecognized litellm time %q", str)
	}
	// Numeric: unix seconds (LiteLLM uses time.time()), possibly fractional.
	var n float64
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	if n <= 0 {
		return nil
	}
	sec := int64(n)
	nsec := int64((n - float64(sec)) * 1e9)
	f.t, f.set = time.Unix(sec, nsec).UTC(), true
	return nil
}
