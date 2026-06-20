package main

import (
	"fmt"
	"io"
	"sync/atomic"
)

// Metrics holds the collector's counters. All access is atomic so the HTTP
// handlers and producer callbacks can update them concurrently without locks.
type Metrics struct {
	RequestsTotal          atomic.Int64
	EventsAccepted         atomic.Int64
	EventsRejectedValidate atomic.Int64
	EventsRejectedBackpres atomic.Int64

	// OTel GenAI ingest (see otel.go).
	OtelSpansConverted atomic.Int64 // gen_ai.* spans mapped to canonical events
	OtelSpansSkipped   atomic.Int64 // spans without GenAI markers (not LLM calls)
	OtelSpansNoTenant  atomic.Int64 // GenAI spans dropped for lacking a tenant
}

// WritePrometheus renders the collector + producer counters in the Prometheus
// text exposition format. Hand-rolled to keep the collector dependency-light
// (no Prometheus client library on a simple counter surface).
func (m *Metrics) WritePrometheus(w io.Writer, prod Producer) {
	ps := prod.Stats()
	metrics := []struct {
		name, help, typ string
		val             int64
	}{
		{"collector_requests_total", "Total ingest requests received.", "counter", m.RequestsTotal.Load()},
		{"collector_events_accepted_total", "Events validated and enqueued for delivery.", "counter", m.EventsAccepted.Load()},
		{"collector_events_rejected_validation_total", "Events rejected by schema validation.", "counter", m.EventsRejectedValidate.Load()},
		{"collector_events_rejected_backpressure_total", "Events rejected because the producer was at capacity.", "counter", m.EventsRejectedBackpres.Load()},
		{"collector_records_produced_total", "Records confirmed produced to the event bus.", "counter", ps.Produced},
		{"collector_records_failed_total", "Records that permanently failed to produce.", "counter", ps.Failed},
		{"collector_records_inflight", "Records currently buffered awaiting delivery.", "gauge", ps.Inflight},
		{"collector_otel_spans_converted_total", "GenAI spans mapped to canonical events.", "counter", m.OtelSpansConverted.Load()},
		{"collector_otel_spans_skipped_total", "OTel spans skipped (no gen_ai.* markers).", "counter", m.OtelSpansSkipped.Load()},
		{"collector_otel_spans_no_tenant_total", "GenAI spans dropped for lacking a tenant.", "counter", m.OtelSpansNoTenant.Load()},
	}
	for _, mt := range metrics {
		_, _ = fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n%s %d\n", mt.name, mt.help, mt.name, mt.typ, mt.name, mt.val)
	}
}
