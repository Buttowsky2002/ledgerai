package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// postOTel sends an OTLP/JSON body to the OTel ingest handler, optionally with
// the batch-level tenant header.
func postOTel(t *testing.T, c *Collector, body, headerTenant string) (*httptest.ResponseRecorder, otelResult) {
	t.Helper()
	r := httptest.NewRequest("POST", "/v1/ingest/otel", bytes.NewReader([]byte(body)))
	if headerTenant != "" {
		r.Header.Set("X-AgentLedger-Tenant", headerTenant)
	}
	w := httptest.NewRecorder()
	c.handleOTel(w, r)
	var res otelResult
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	return w, res
}

// otelExport builds an OTLP/JSON ExportTraceServiceRequest with one resource
// (carrying resAttrs) and the given spans.
func otelExport(resAttrs []otelKeyValue, spans ...otelSpan) string {
	req := otelExportRequest{ResourceSpans: []otelResourceSpans{{
		Resource:   otelResource{Attributes: resAttrs},
		ScopeSpans: []otelScopeSpans{{Spans: spans}},
	}}}
	b, _ := json.Marshal(req)
	return string(b)
}

func strVal(s string) otelAnyValue             { return otelAnyValue{StringValue: &s} }
func intVal(s string) otelAnyValue             { n := json.Number(s); return otelAnyValue{IntValue: &n} }
func kv(k string, v otelAnyValue) otelKeyValue { return otelKeyValue{Key: k, Value: v} }

// a fully-populated gen_ai chat span; start/end one second apart.
func genAISpan() otelSpan {
	return otelSpan{
		TraceID:           "trace123",
		SpanID:            "span456",
		Name:              "chat gpt-4o",
		StartTimeUnixNano: "1718800000000000000",
		EndTimeUnixNano:   "1718800001000000000",
		Attributes: []otelKeyValue{
			kv("gen_ai.system", strVal("openai")),
			kv("gen_ai.request.model", strVal("gpt-4o")),
			kv("gen_ai.response.model", strVal("gpt-4o-2024-08-06")),
			kv("gen_ai.operation.name", strVal("chat")),
			kv("gen_ai.usage.input_tokens", intVal("100")),
			kv("gen_ai.usage.output_tokens", intVal("40")),
		},
		Status: otelStatus{Code: 1},
	}
}

func TestOTelConvertsGenAISpan(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	body := otelExport([]otelKeyValue{kv("agentledger.tenant_id", strVal("t_otel"))}, genAISpan())

	w, res := postOTel(t, c, body, "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if res.Accepted != 1 || res.SpansSkipped != 0 {
		t.Fatalf("result = %+v, want accepted=1 skipped=0", res)
	}
	if m.count() != 1 {
		t.Fatalf("expected 1 produced record, got %d", m.count())
	}
	if string(m.records[0].key) != "t_otel" {
		t.Fatalf("partition key = %q, want tenant t_otel", m.records[0].key)
	}

	var ev map[string]any
	if err := json.Unmarshal(m.records[0].value, &ev); err != nil {
		t.Fatalf("produced value not JSON: %v", err)
	}
	checks := map[string]any{
		"call_id": "span456", "tenant_id": "t_otel", "source": "otel",
		"provider": "openai", "request_model": "gpt-4o",
		"response_model": "gpt-4o-2024-08-06", "operation_name": "chat",
		"status": "ok", "run_id": "trace123",
	}
	for k, want := range checks {
		if ev[k] != want {
			t.Errorf("%s = %v, want %v", k, ev[k], want)
		}
	}
	// tokens come back as float64 through JSON.
	if ev["input_tokens"] != float64(100) || ev["output_tokens"] != float64(40) {
		t.Errorf("tokens = %v/%v, want 100/40", ev["input_tokens"], ev["output_tokens"])
	}
	if ev["latency_ms"] != float64(1000) {
		t.Errorf("latency_ms = %v, want 1000", ev["latency_ms"])
	}
}

func TestOTelSkipsNonLLMSpan(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	httpSpan := otelSpan{
		SpanID:            "s1",
		Name:              "GET /healthz",
		StartTimeUnixNano: "1718800000000000000",
		EndTimeUnixNano:   "1718800000005000000",
		Attributes:        []otelKeyValue{kv("http.method", strVal("GET"))},
	}
	body := otelExport([]otelKeyValue{kv("agentledger.tenant_id", strVal("t1"))}, httpSpan, genAISpan())

	_, res := postOTel(t, c, body, "")
	if res.Accepted != 1 || res.SpansSkipped != 1 {
		t.Fatalf("result = %+v, want accepted=1 skipped=1 (non-LLM span skipped)", res)
	}
	if m.count() != 1 {
		t.Fatalf("only the gen_ai span should produce, got %d records", m.count())
	}
}

func TestOTelLegacyTokenAttrs(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	span := genAISpan()
	// Replace usage attrs with the older prompt/completion_tokens names.
	span.Attributes = []otelKeyValue{
		kv("gen_ai.system", strVal("anthropic")),
		kv("gen_ai.request.model", strVal("claude-3-5-sonnet")),
		kv("gen_ai.usage.prompt_tokens", intVal("7")),
		kv("gen_ai.usage.completion_tokens", intVal("3")),
	}
	body := otelExport([]otelKeyValue{kv("agentledger.tenant_id", strVal("t1"))}, span)

	postOTel(t, c, body, "")
	if m.count() != 1 {
		t.Fatalf("expected 1 record, got %d", m.count())
	}
	var ev map[string]any
	_ = json.Unmarshal(m.records[0].value, &ev)
	if ev["input_tokens"] != float64(7) || ev["output_tokens"] != float64(3) {
		t.Fatalf("legacy tokens = %v/%v, want 7/3", ev["input_tokens"], ev["output_tokens"])
	}
}

func TestOTelTenantFromHeader(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	// No tenant attribute anywhere; rely on the batch header.
	body := otelExport(nil, genAISpan())

	w, res := postOTel(t, c, body, "t_header")
	if w.Code != http.StatusOK || res.Accepted != 1 {
		t.Fatalf("status=%d result=%+v, want 200 accepted=1 via header", w.Code, res)
	}
	if string(m.records[0].key) != "t_header" {
		t.Fatalf("tenant = %q, want t_header", m.records[0].key)
	}
}

func TestOTelDropsSpanWithoutTenant(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m) // no default tenant configured
	body := otelExport(nil, genAISpan())

	w, res := postOTel(t, c, body, "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	// A GenAI span with no resolvable tenant is dropped (counted as skipped), not produced.
	if m.count() != 0 {
		t.Fatalf("span without tenant must not be produced, got %d", m.count())
	}
	if c.metrics.OtelSpansNoTenant.Load() != 1 {
		t.Fatalf("OtelSpansNoTenant = %d, want 1", c.metrics.OtelSpansNoTenant.Load())
	}
	_ = res
}

func TestOTelErrorStatusMapped(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	span := genAISpan()
	span.Status = otelStatus{Code: 2} // ERROR
	body := otelExport([]otelKeyValue{kv("agentledger.tenant_id", strVal("t1"))}, span)

	postOTel(t, c, body, "")
	var ev map[string]any
	_ = json.Unmarshal(m.records[0].value, &ev)
	if ev["status"] != "upstream_error" {
		t.Fatalf("status = %v, want upstream_error", ev["status"])
	}
}

func TestOTelBackpressureReturns429(t *testing.T) {
	m := &mockProducer{full: true}
	c := testCollector(t, m)
	body := otelExport([]otelKeyValue{kv("agentledger.tenant_id", strVal("t1"))}, genAISpan())

	w, res := postOTel(t, c, body, "")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 on backpressure", w.Code)
	}
	if res.RejectedBusy != 1 {
		t.Fatalf("result = %+v, want rejected_backpressure=1", res)
	}
}

func TestOTelMalformedBody(t *testing.T) {
	c := testCollector(t, &mockProducer{})
	w, _ := postOTel(t, c, `{not otlp`, "")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// a tool/MCP span per the OTel GenAI execute_tool convention.
func toolSpan() otelSpan {
	return otelSpan{
		TraceID:           "traceTool",
		SpanID:            "spanTool",
		Name:              "execute_tool shell.exec",
		StartTimeUnixNano: "1718800000000000000",
		EndTimeUnixNano:   "1718800000500000000",
		Attributes: []otelKeyValue{
			kv("gen_ai.operation.name", strVal("execute_tool")),
			kv("gen_ai.tool.name", strVal("shell.exec")),
			kv("gen_ai.tool.call.id", strVal("toolcall_1")),
			kv("agentledger.agent_id", strVal("triage")),
			kv("agentledger.mcp_server", strVal("filesystem")),
		},
		Status: otelStatus{Code: 1},
	}
}

func TestOTelConvertsToolSpan(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	body := otelExport([]otelKeyValue{kv("agentledger.tenant_id", strVal("t_otel"))}, toolSpan())

	w, res := postOTel(t, c, body, "")
	if w.Code != http.StatusOK || res.Accepted != 1 || res.SpansSkipped != 0 {
		t.Fatalf("status=%d result=%+v, want 200 accepted=1 skipped=0", w.Code, res)
	}
	if c.metrics.OtelToolSpansConverted.Load() != 1 {
		t.Fatalf("OtelToolSpansConverted = %d, want 1", c.metrics.OtelToolSpansConverted.Load())
	}
	if string(m.records[0].key) != "t_otel" {
		t.Fatalf("partition key = %q, want tenant t_otel", m.records[0].key)
	}
	var ev map[string]any
	if err := json.Unmarshal(m.records[0].value, &ev); err != nil {
		t.Fatalf("produced value not JSON: %v", err)
	}
	checks := map[string]any{
		"kind": "tool_call", "tenant_id": "t_otel", "source": "otel",
		"tool_call_id": "toolcall_1", "tool_name": "shell.exec",
		"mcp_server": "filesystem", "agent_id": "triage", "run_id": "traceTool",
	}
	for k, want := range checks {
		if ev[k] != want {
			t.Errorf("%s = %v, want %v", k, ev[k], want)
		}
	}
}

func TestOTelToolSpanFallsBackToSpanIDAndName(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	span := toolSpan()
	// No gen_ai.tool.call.id and no gen_ai.tool.name: rely on execute_tool +
	// the span id (dedup key) and span name (tool name).
	span.Attributes = []otelKeyValue{
		kv("gen_ai.operation.name", strVal("execute_tool")),
		kv("agentledger.tenant_id", strVal("t1")),
	}
	span.Name = "db.query"
	body := otelExport(nil, span)

	postOTel(t, c, body, "")
	if m.count() != 1 {
		t.Fatalf("expected 1 tool_call, got %d", m.count())
	}
	var ev map[string]any
	_ = json.Unmarshal(m.records[0].value, &ev)
	if ev["tool_call_id"] != "spanTool" {
		t.Errorf("tool_call_id = %v, want spanTool (span id fallback)", ev["tool_call_id"])
	}
	if ev["tool_name"] != "db.query" {
		t.Errorf("tool_name = %v, want db.query (span name fallback)", ev["tool_name"])
	}
}

func TestOTelMixedTraceLLMAndTool(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	body := otelExport([]otelKeyValue{kv("agentledger.tenant_id", strVal("t1"))}, genAISpan(), toolSpan())

	_, res := postOTel(t, c, body, "")
	if res.Accepted != 2 || res.SpansSkipped != 0 {
		t.Fatalf("result = %+v, want accepted=2 skipped=0", res)
	}
	if c.metrics.OtelSpansConverted.Load() != 1 || c.metrics.OtelToolSpansConverted.Load() != 1 {
		t.Fatalf("converted llm=%d tool=%d, want 1/1",
			c.metrics.OtelSpansConverted.Load(), c.metrics.OtelToolSpansConverted.Load())
	}
	// The execute_tool span must produce a tool_call, never be misread as llm_call.
	kinds := map[string]int{}
	for _, r := range m.records {
		var ev map[string]any
		_ = json.Unmarshal(r.value, &ev)
		k, _ := ev["kind"].(string)
		if k == "" {
			k = "llm_call"
		}
		kinds[k]++
	}
	if kinds["llm_call"] != 1 || kinds["tool_call"] != 1 {
		t.Fatalf("kinds = %v, want one llm_call and one tool_call", kinds)
	}
}

func TestOTelConfiguredTenantAttr(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	c.otelTenantAttr = "tenant.id" // customer maps an existing attribute
	span := genAISpan()
	span.Attributes = append(span.Attributes, kv("tenant.id", strVal("t_custom")))
	body := otelExport(nil, span)

	postOTel(t, c, body, "")
	if m.count() != 1 || string(m.records[0].key) != "t_custom" {
		t.Fatalf("expected tenant t_custom via configured attr, got count=%d", m.count())
	}
}
