package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

// OTel GenAI ingestion — the "turn any OTel-instrumented stack into a data
// source" front door (ARCHITECTURE_PIVOT.md, Pillar 1). Anyone already emitting
// gen_ai.* spans (OpenLLMetry, Langfuse, Datadog, raw OTel SDK) can stream
// OTLP/JSON traces here without code changes; we map the GenAI semantic
// conventions onto the canonical llm_call event and run them through the same
// validate → produce path as every other source.
//
// SECURITY (CLAUDE.md rule 15): OTLP spans are untrusted third-party input. We
// only read the attributes we map, validate every constructed event against the
// canonical schema before producing, and never copy span bodies/log records or
// any prompt/completion content into the pipeline (rule 2).
//
// Scope note (see ADR-022): this accepts OTLP/JSON only and replies with a
// compact JSON summary + HTTP 200 on success / 429 on backpressure. Full OTLP
// response conformance (protobuf content-type, ExportTraceServiceResponse /
// partialSuccess schema) is deferred — most exporters only branch on the 2xx.

// otelTenantAttrDefault is the resource/span attribute key carrying the
// AgentLedger tenant. Overridable via AGENTLEDGER_OTEL_TENANT_ATTR so customers
// can map an existing attribute instead of re-instrumenting.
const otelTenantAttrDefault = "agentledger.tenant_id"

// otelExportRequest mirrors the OTLP/JSON ExportTraceServiceRequest envelope.
// Only the fields we consume are modeled; unknown fields are ignored (the
// schema gate is the canonical event, not this struct).
type otelExportRequest struct {
	ResourceSpans []otelResourceSpans `json:"resourceSpans"`
}

type otelResourceSpans struct {
	Resource   otelResource     `json:"resource"`
	ScopeSpans []otelScopeSpans `json:"scopeSpans"`
}

type otelResource struct {
	Attributes []otelKeyValue `json:"attributes"`
}

type otelScopeSpans struct {
	Spans []otelSpan `json:"spans"`
}

type otelSpan struct {
	TraceID           string         `json:"traceId"`
	SpanID            string         `json:"spanId"`
	Name              string         `json:"name"`
	StartTimeUnixNano json.Number    `json:"startTimeUnixNano"`
	EndTimeUnixNano   json.Number    `json:"endTimeUnixNano"`
	Attributes        []otelKeyValue `json:"attributes"`
	Status            otelStatus     `json:"status"`
}

type otelStatus struct {
	Code int `json:"code"` // 0 UNSET, 1 OK, 2 ERROR (OTLP status codes)
}

type otelKeyValue struct {
	Key   string       `json:"key"`
	Value otelAnyValue `json:"value"`
}

// otelAnyValue models the OTLP AnyValue. In OTLP/JSON, intValue is encoded as a
// string (proto3 JSON int64 rule) but some emitters send a bare number, so we
// accept json.Number for both int and double.
type otelAnyValue struct {
	StringValue *string      `json:"stringValue"`
	IntValue    *json.Number `json:"intValue"`
	DoubleValue *json.Number `json:"doubleValue"`
	BoolValue   *bool        `json:"boolValue"`
}

func (v otelAnyValue) str() (string, bool) {
	if v.StringValue != nil {
		return *v.StringValue, true
	}
	return "", false
}

func (v otelAnyValue) int() (int64, bool) {
	switch {
	case v.IntValue != nil:
		if n, err := strconv.ParseInt(string(*v.IntValue), 10, 64); err == nil {
			return n, true
		}
	case v.DoubleValue != nil:
		if f, err := v.DoubleValue.Float64(); err == nil {
			return int64(f), true
		}
	}
	return 0, false
}

func (v otelAnyValue) float() (float64, bool) {
	switch {
	case v.DoubleValue != nil:
		if f, err := v.DoubleValue.Float64(); err == nil {
			return f, true
		}
	case v.IntValue != nil:
		if f, err := v.IntValue.Float64(); err == nil {
			return f, true
		}
	}
	return 0, false
}

// attrs flattens a key/value list into a lookup map.
func attrs(kvs []otelKeyValue) map[string]otelAnyValue {
	m := make(map[string]otelAnyValue, len(kvs))
	for _, kv := range kvs {
		m[kv.Key] = kv.Value
	}
	return m
}

// otelResult summarizes an OTLP ingest request.
type otelResult struct {
	Accepted     int `json:"accepted"`
	RejectedBad  int `json:"rejected_validation"`
	RejectedBusy int `json:"rejected_backpressure"`
	SpansSkipped int `json:"spans_skipped"` // non-LLM spans (no gen_ai.* markers)
}

// handleOTel ingests an OTLP/JSON trace export, converting gen_ai.* spans to
// canonical llm_call events. Spans without GenAI markers are skipped, not
// rejected (a trace legitimately mixes LLM and non-LLM spans).
func (c *Collector) handleOTel(w http.ResponseWriter, r *http.Request) {
	c.metrics.RequestsTotal.Add(1)

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "could not read body"})
		return
	}
	var req otelExportRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid OTLP/JSON trace export"})
		return
	}

	// Batch-level tenant fallback: a header lets a per-tenant collector route
	// accept exporters that cannot set a resource attribute.
	headerTenant := r.Header.Get("X-AgentLedger-Tenant")

	var res otelResult
	for _, rs := range req.ResourceSpans {
		resAttrs := attrs(rs.Resource.Attributes)
		for _, ss := range rs.ScopeSpans {
			for i := range ss.Spans {
				sp := &ss.Spans[i]

				// Tool/MCP spans feed the agent-native risk engine. Claim them
				// first so a tool span is never misread as an llm_call.
				if isToolSpan(sp) {
					ev, ok := c.spanToToolEvent(sp, resAttrs, headerTenant)
					if !ok {
						res.SpansSkipped++
						c.metrics.OtelSpansSkipped.Add(1)
						continue
					}
					switch c.produceValidated(ev) {
					case outcomeAccepted:
						res.Accepted++
						c.metrics.OtelToolSpansConverted.Add(1)
					case outcomeBackpressure:
						res.RejectedBusy++
					default:
						res.RejectedBad++
					}
					continue
				}

				ev, ok := c.spanToEvent(sp, resAttrs, headerTenant)
				if !ok {
					res.SpansSkipped++
					c.metrics.OtelSpansSkipped.Add(1)
					continue
				}
				switch c.produceValidated(ev) {
				case outcomeAccepted:
					res.Accepted++
					c.metrics.OtelSpansConverted.Add(1)
				case outcomeBackpressure:
					res.RejectedBusy++
				default:
					res.RejectedBad++
				}
			}
		}
	}

	// OTLP throttling is signalled with 429 (exporters back off + retry); any
	// successful conversion returns 200 so we don't ask for a needless replay.
	status := http.StatusOK
	if res.Accepted == 0 && res.RejectedBusy > 0 {
		status = http.StatusTooManyRequests
	}
	writeJSON(w, status, res)
}

// spanToEvent maps one OTLP span to a canonical llm_call event. It returns
// ok=false for spans that are not GenAI LLM calls (no gen_ai.* markers) or that
// lack a resolvable tenant. span and resource attributes are merged with span
// attributes winning.
func (c *Collector) spanToEvent(span *otelSpan, resAttrs map[string]otelAnyValue, headerTenant string) (map[string]any, bool) {
	spanAttrs := attrs(span.Attributes)

	// get resolves an attribute string, span scope first then resource scope.
	get := func(keys ...string) (string, bool) {
		for _, k := range keys {
			if v, ok := spanAttrs[k]; ok {
				if s, ok := v.str(); ok && s != "" {
					return s, true
				}
			}
			if v, ok := resAttrs[k]; ok {
				if s, ok := v.str(); ok && s != "" {
					return s, true
				}
			}
		}
		return "", false
	}
	getInt := func(keys ...string) (int64, bool) {
		for _, k := range keys {
			if v, ok := spanAttrs[k]; ok {
				if n, ok := v.int(); ok {
					return n, true
				}
			}
		}
		return 0, false
	}

	system, hasSystem := get("gen_ai.system")
	reqModel, hasReqModel := get("gen_ai.request.model")
	opName, hasOp := get("gen_ai.operation.name")
	// Tool/MCP spans are mapped by spanToToolEvent, never as llm_calls — even if
	// they also carry a gen_ai.operation.name marker.
	if opName == "execute_tool" {
		return nil, false
	}
	if _, isTool := get("gen_ai.tool.name"); isTool {
		return nil, false
	}
	// A span is an LLM call only if it carries GenAI markers. This is what lets
	// callers POST whole traces and have us pick out the LLM spans.
	if !hasSystem && !hasReqModel && !hasOp {
		return nil, false
	}

	tenant := c.resolveOtelTenant(spanAttrs, resAttrs, headerTenant)
	if tenant == "" {
		c.metrics.OtelSpansNoTenant.Add(1)
		slog.Debug("otel span dropped: no tenant", "span", span.Name)
		return nil, false
	}

	callID := span.SpanID
	if callID == "" {
		callID = span.TraceID
	}
	if callID == "" {
		return nil, false
	}

	ev := map[string]any{
		"kind":      "llm_call",
		"call_id":   callID,
		"tenant_id": tenant,
		"ts":        otelNanoToRFC3339(span.StartTimeUnixNano),
		"source":    "otel",
		"streamed":  false,
	}
	if system != "" {
		ev["provider"] = system
	}
	if reqModel != "" {
		ev["request_model"] = reqModel
	}
	if respModel, ok := get("gen_ai.response.model"); ok {
		ev["response_model"] = respModel
	}
	if opName != "" {
		ev["operation_name"] = opName
	}

	// Usage: prefer the current gen_ai.usage.{input,output}_tokens, fall back to
	// the older prompt/completion_tokens still emitted by some instrumentations.
	if in, ok := getInt("gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens"); ok && in >= 0 {
		ev["input_tokens"] = in
	}
	if out, ok := getInt("gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens"); ok && out >= 0 {
		ev["output_tokens"] = out
	}
	// Cost is not a standard gen_ai attribute; honor it only when an emitter
	// supplies one. Otherwise cost stays unset and is derived downstream.
	if v, ok := spanAttrs["gen_ai.usage.cost"]; ok {
		if f, ok := v.float(); ok && f >= 0 {
			ev["cost_usd"] = f
		}
	}

	// Attribution dimensions (optional; agentledger.* keys win over OTel conventions).
	if v, ok := get("agentledger.user_id", "enduser.id", "user.id"); ok {
		ev["user_id"] = v
	}
	if v, ok := get("agentledger.app_id", "service.name"); ok {
		ev["app_id"] = v
	}
	if v, ok := get("agentledger.environment", "deployment.environment"); ok {
		ev["environment"] = v
	}
	if v, ok := get("agentledger.team_id"); ok {
		ev["team_id"] = v
	}
	if v, ok := get("agentledger.agent_id", "gen_ai.agent.id"); ok {
		ev["agent_id"] = v
	}
	// Run id: explicit attribute wins; otherwise the trace groups a run's spans.
	if v, ok := get("agentledger.run_id"); ok {
		ev["run_id"] = v
	} else if span.TraceID != "" {
		ev["run_id"] = span.TraceID
	}

	// Latency from the span window; status from the OTel span status.
	if lat := otelLatencyMs(span.StartTimeUnixNano, span.EndTimeUnixNano); lat >= 0 {
		ev["latency_ms"] = lat
	}
	if span.Status.Code == 2 {
		ev["status"] = "upstream_error"
	} else {
		ev["status"] = "ok"
	}

	return ev, true
}

// isToolSpan reports whether an OTLP span is a tool/MCP invocation, per the OTel
// GenAI conventions: a gen_ai.tool.name attribute or an execute_tool operation.
func isToolSpan(span *otelSpan) bool {
	for _, kv := range span.Attributes {
		switch kv.Key {
		case "gen_ai.tool.name":
			if s, ok := kv.Value.str(); ok && s != "" {
				return true
			}
		case "gen_ai.operation.name":
			if s, ok := kv.Value.str(); ok && s == "execute_tool" {
				return true
			}
		}
	}
	return false
}

// spanToToolEvent maps one OTLP tool/MCP span to a canonical tool_call event for
// the agent-native risk engine (agent_tool_calls). The caller must have confirmed
// isToolSpan(span). It returns ok=false only when the span lacks a resolvable
// tenant; a missing tool_call_id/tool_name is left to the validation boundary to
// reject (so it is counted as a validation rejection, not silently dropped).
func (c *Collector) spanToToolEvent(span *otelSpan, resAttrs map[string]otelAnyValue, headerTenant string) (map[string]any, bool) {
	spanAttrs := attrs(span.Attributes)
	get := func(keys ...string) (string, bool) {
		for _, k := range keys {
			if v, ok := spanAttrs[k]; ok {
				if s, ok := v.str(); ok && s != "" {
					return s, true
				}
			}
			if v, ok := resAttrs[k]; ok {
				if s, ok := v.str(); ok && s != "" {
					return s, true
				}
			}
		}
		return "", false
	}

	tenant := c.resolveOtelTenant(spanAttrs, resAttrs, headerTenant)
	if tenant == "" {
		c.metrics.OtelSpansNoTenant.Add(1)
		slog.Debug("otel tool span dropped: no tenant", "span", span.Name)
		return nil, false
	}

	// tool_call_id is the agent_tool_calls dedup key: OTel's gen_ai.tool.call.id,
	// else the span id (unique per call), else the trace id.
	toolCallID, _ := get("gen_ai.tool.call.id")
	if toolCallID == "" {
		toolCallID = span.SpanID
	}
	if toolCallID == "" {
		toolCallID = span.TraceID
	}

	// tool_name: the governed dimension; fall back to the span name.
	toolName, _ := get("gen_ai.tool.name")
	if toolName == "" {
		toolName = span.Name
	}

	ev := map[string]any{
		"kind":         "tool_call",
		"tenant_id":    tenant,
		"ts":           otelNanoToRFC3339(span.StartTimeUnixNano),
		"tool_call_id": toolCallID,
		"tool_name":    toolName,
		"source":       "otel",
	}
	if v, ok := get("agentledger.mcp_server", "mcp.server.name"); ok {
		ev["mcp_server"] = v
	}
	if v, ok := get("agentledger.agent_id", "gen_ai.agent.id"); ok {
		ev["agent_id"] = v
	}
	// Run id: explicit attribute wins; otherwise the trace groups a run's spans.
	if v, ok := get("agentledger.run_id"); ok {
		ev["run_id"] = v
	} else if span.TraceID != "" {
		ev["run_id"] = span.TraceID
	}
	return ev, true
}

func (c *Collector) resolveOtelTenant(spanAttrs, resAttrs map[string]otelAnyValue, headerTenant string) string {
	if v, ok := spanAttrs[c.otelTenantAttr]; ok {
		if s, ok := v.str(); ok && s != "" {
			return s
		}
	}
	if v, ok := resAttrs[c.otelTenantAttr]; ok {
		if s, ok := v.str(); ok && s != "" {
			return s
		}
	}
	if headerTenant != "" {
		return headerTenant
	}
	return c.otelDefaultTenant
}

// otelNanoToRFC3339 converts an OTLP unix-nano timestamp to the RFC3339/UTC
// string the canonical schema's date-time format expects. An empty/zero value
// is rejected by the schema (ts is required), surfacing as a validation reject.
func otelNanoToRFC3339(nano json.Number) string {
	n, err := strconv.ParseInt(string(nano), 10, 64)
	if err != nil || n <= 0 {
		return ""
	}
	return time.Unix(0, n).UTC().Format(time.RFC3339Nano)
}

// otelLatencyMs computes end-start in milliseconds; -1 when unavailable.
func otelLatencyMs(start, end json.Number) int64 {
	s, err1 := strconv.ParseInt(string(start), 10, 64)
	e, err2 := strconv.ParseInt(string(end), 10, 64)
	if err1 != nil || err2 != nil || e < s || s <= 0 {
		return -1
	}
	return (e - s) / 1_000_000
}
