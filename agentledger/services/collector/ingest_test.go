package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

const schemaPath = "../../schemas/events/llm_call.schema.json"

// mockProducer records produced payloads in memory and can simulate backpressure.
type mockProducer struct {
	mu      sync.Mutex
	records []record
	full    bool
}

type record struct{ key, value []byte }

func (m *mockProducer) TryProduce(key, value []byte) error {
	if m.full {
		return ErrBackpressure
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.records = append(m.records, record{key: key, value: value})
	return nil
}
func (m *mockProducer) Stats() ProducerStats { return ProducerStats{} }
func (m *mockProducer) Ready() bool          { return true }
func (m *mockProducer) Close()               {}

func (m *mockProducer) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.records)
}

func testCollector(t *testing.T, prod Producer) *Collector {
	t.Helper()
	v, err := NewValidator(schemaPath)
	if err != nil {
		t.Fatalf("validator: %v", err)
	}
	return &Collector{validator: v, producer: prod, metrics: &Metrics{}, maxBatch: 1000, otelTenantAttr: otelTenantAttrDefault}
}

func post(t *testing.T, c *Collector, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("POST", "/v1/events", bytes.NewReader([]byte(body)))
	w := httptest.NewRecorder()
	c.handleEvents(w, r)
	return w
}

func validEvent() string {
	b, _ := json.Marshal(map[string]any{
		"call_id": "call_abc", "ts": "2026-06-16T12:00:00Z", "tenant_id": "t1",
		"provider": "openai", "request_model": "gpt-4o",
		"input_tokens": 10, "output_tokens": 5, "cost_usd": 0.001,
		"status": "ok", "dlp_action": "allow",
	})
	return string(b)
}

func TestIngestValidLLMCall(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	w := post(t, c, validEvent())
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if m.count() != 1 {
		t.Fatalf("expected 1 produced record, got %d", m.count())
	}
	if string(m.records[0].key) != "t1" {
		t.Fatalf("partition key = %q, want tenant t1", m.records[0].key)
	}
}

func TestIngestRejectsMissingRequired(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	// missing call_id
	w := post(t, c, `{"ts":"2026-06-16T12:00:00Z","tenant_id":"t1"}`)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", w.Code)
	}
	if m.count() != 0 {
		t.Fatalf("invalid event should not be produced")
	}
}

// The schema's additionalProperties:false is a security control: a raw-content
// field must never pass the ingest boundary (CLAUDE.md rule 2).
func TestIngestRejectsRawContentField(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	w := post(t, c, `{"call_id":"c1","ts":"2026-06-16T12:00:00Z","tenant_id":"t1","prompt":"my secret prompt"}`)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (raw content must be rejected)", w.Code)
	}
	if m.count() != 0 {
		t.Fatalf("event with raw content field must not be produced")
	}
}

func TestIngestRejectsBadTimestamp(t *testing.T) {
	c := testCollector(t, &mockProducer{})
	w := post(t, c, `{"call_id":"c1","ts":"not-a-date","tenant_id":"t1"}`)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 for bad ts", w.Code)
	}
}

func TestIngestRejectsBadEnum(t *testing.T) {
	c := testCollector(t, &mockProducer{})
	w := post(t, c, `{"call_id":"c1","ts":"2026-06-16T12:00:00Z","tenant_id":"t1","status":"bogus"}`)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 for bad status enum", w.Code)
	}
}

func TestIngestNDJSON(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	body := validEvent() + "\n" + validEvent()
	w := post(t, c, body)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d", w.Code)
	}
	if m.count() != 2 {
		t.Fatalf("expected 2 records from NDJSON, got %d", m.count())
	}
}

func TestIngestJSONArray(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	body := "[" + validEvent() + "," + validEvent() + "," + validEvent() + "]"
	w := post(t, c, body)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d", w.Code)
	}
	if m.count() != 3 {
		t.Fatalf("expected 3 records from array, got %d", m.count())
	}
}

func TestIngestPartialAcceptance(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	body := validEvent() + "\n" + `{"ts":"2026-06-16T12:00:00Z","tenant_id":"t1"}` // 2nd invalid
	w := post(t, c, body)
	if w.Code != http.StatusAccepted { // at least one accepted → 202
		t.Fatalf("status = %d, want 202", w.Code)
	}
	var res ingestResult
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if res.Accepted != 1 || res.RejectedBad != 1 {
		t.Fatalf("summary = %+v, want accepted=1 rejected=1", res)
	}
}

func TestIngestBackpressureReturns429(t *testing.T) {
	m := &mockProducer{full: true}
	c := testCollector(t, m)
	w := post(t, c, validEvent())
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
}

func TestIngestAgentRunEnvelope(t *testing.T) {
	m := &mockProducer{}
	c := testCollector(t, m)
	// agent_run has fields not in the llm_call schema; it must pass via the
	// envelope check, not strict llm_call validation.
	w := post(t, c, `{"kind":"agent_run","run_id":"run_1","ts":"2026-06-16T12:00:00Z","tenant_id":"t1","objective":"triage","total_cost_usd":0.5}`)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 for agent_run", w.Code)
	}
	if m.count() != 1 {
		t.Fatalf("agent_run should be produced")
	}
}

func TestIngestUnknownKindRejected(t *testing.T) {
	c := testCollector(t, &mockProducer{})
	w := post(t, c, `{"kind":"banana","ts":"2026-06-16T12:00:00Z","tenant_id":"t1"}`)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 for unknown kind", w.Code)
	}
}

func TestIngestMalformedBody(t *testing.T) {
	c := testCollector(t, &mockProducer{})
	w := post(t, c, `{not json`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestIngestEmptyBody(t *testing.T) {
	c := testCollector(t, &mockProducer{})
	w := post(t, c, "")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for empty body", w.Code)
	}
}
