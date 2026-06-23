package main

import (
	"fmt"
	"io"
	"sync/atomic"
)

// Gateway metrics — request counters + a policy-overhead latency histogram,
// rendered in the Prometheus text exposition format. Hand-rolled and stdlib-only
// (no prometheus client dependency — the gateway data plane stays dependency-free
// per CLAUDE.md rule 12, mirroring the workers' WritePrometheus). All fields are
// atomic so Observe is lock-free on the hot path.
//
// "Policy overhead" is the gateway's own inline processing time EXCLUDING the
// upstream round-trip — the quantity the p95 < 75ms budget governs (CLAUDE.md §5).

// Cumulative histogram bucket upper bounds, in milliseconds.
var overheadBucketsMs = [...]float64{1, 2, 5, 10, 25, 50, 75, 100, 250, 500, 1000}

// Metrics holds gateway request counters and the policy-overhead latency
// histogram. All fields are atomic so Observe is lock-free on the hot path.
type Metrics struct {
	reqOK      atomic.Int64
	reqBlocked atomic.Int64
	reqError   atomic.Int64

	// bucket holds per-bucket (non-cumulative) counts; sumMicros accumulates
	// overhead in microseconds (avoids atomic floats); count is the total.
	bucket    [len(overheadBucketsMs)]atomic.Int64
	sumMicros atomic.Int64
	count     atomic.Int64
}

// NewMetrics returns a zeroed Metrics.
func NewMetrics() *Metrics { return &Metrics{} }

// statusClass collapses an event status into a metric label.
func statusClass(status string) string {
	switch status {
	case "ok":
		return "ok"
	case "upstream_error", "client_error":
		return "error"
	default:
		return "blocked" // blocked_policy | blocked_tool | blocked_dlp | blocked_budget | blocked_rate
	}
}

// Observe records one request's policy overhead (milliseconds) and outcome class.
func (m *Metrics) Observe(overheadMs float64, class string) {
	if m == nil {
		return
	}
	switch class {
	case "ok":
		m.reqOK.Add(1)
	case "error":
		m.reqError.Add(1)
	default:
		m.reqBlocked.Add(1)
	}
	m.count.Add(1)
	m.sumMicros.Add(int64(overheadMs * 1000))
	for i, ub := range overheadBucketsMs {
		if overheadMs <= ub {
			m.bucket[i].Add(1)
			return // values above the last finite bound land only in +Inf (= count)
		}
	}
}

// WritePrometheus renders the metrics in the Prometheus text exposition format.
func (m *Metrics) WritePrometheus(w io.Writer) {
	ok, blocked, errd := m.reqOK.Load(), m.reqBlocked.Load(), m.reqError.Load()
	_, _ = fmt.Fprint(w, "# HELP gateway_requests_total Gateway requests by outcome class.\n# TYPE gateway_requests_total counter\n")
	_, _ = fmt.Fprintf(w, "gateway_requests_total{status=\"ok\"} %d\n", ok)
	_, _ = fmt.Fprintf(w, "gateway_requests_total{status=\"blocked\"} %d\n", blocked)
	_, _ = fmt.Fprintf(w, "gateway_requests_total{status=\"error\"} %d\n", errd)

	_, _ = fmt.Fprint(w, "# HELP gateway_policy_overhead_ms Inline policy overhead (excludes upstream round-trip), milliseconds.\n# TYPE gateway_policy_overhead_ms histogram\n")
	var cumulative int64
	for i, ub := range overheadBucketsMs {
		cumulative += m.bucket[i].Load()
		_, _ = fmt.Fprintf(w, "gateway_policy_overhead_ms_bucket{le=\"%g\"} %d\n", ub, cumulative)
	}
	count := m.count.Load()
	_, _ = fmt.Fprintf(w, "gateway_policy_overhead_ms_bucket{le=\"+Inf\"} %d\n", count)
	_, _ = fmt.Fprintf(w, "gateway_policy_overhead_ms_sum %g\n", float64(m.sumMicros.Load())/1000.0)
	_, _ = fmt.Fprintf(w, "gateway_policy_overhead_ms_count %d\n", count)
}
