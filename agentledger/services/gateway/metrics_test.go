package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestMetricsBucketingAndRender(t *testing.T) {
	m := NewMetrics()
	m.Observe(0.5, "ok")     // <= 1
	m.Observe(3, "ok")       // <= 5
	m.Observe(80, "blocked") // <= 100
	m.Observe(2000, "error") // above the last finite bound → only +Inf

	var buf bytes.Buffer
	m.WritePrometheus(&buf)
	out := buf.String()

	// Observed: 0.5, 3, 80, 2000. Cumulative buckets: le=1 →1, le=5 →2 (0.5,3),
	// le=75 →2 (80 not yet), le=100 →3 (+80), le=1000 →3 (2000 excluded), +Inf →4.
	checks := []string{
		`gateway_requests_total{status="ok"} 2`,
		`gateway_requests_total{status="blocked"} 1`,
		`gateway_requests_total{status="error"} 1`,
		`gateway_policy_overhead_ms_bucket{le="1"} 1`,
		`gateway_policy_overhead_ms_bucket{le="5"} 2`,
		`gateway_policy_overhead_ms_bucket{le="75"} 2`,
		`gateway_policy_overhead_ms_bucket{le="100"} 3`,
		`gateway_policy_overhead_ms_bucket{le="1000"} 3`,
		`gateway_policy_overhead_ms_bucket{le="+Inf"} 4`,
		`gateway_policy_overhead_ms_count 4`,
	}
	for _, c := range checks {
		if !strings.Contains(out, c) {
			t.Errorf("metrics output missing %q\n---\n%s", c, out)
		}
	}
}

func TestMetricsNilSafe(t *testing.T) {
	var m *Metrics
	m.Observe(1, "ok") // must not panic
}

// A successful proxied request and a DLP-blocked request must both be observed,
// with the right outcome class.
func TestMetricsRecordedOnRequests(t *testing.T) {
	up := mockUpstream(t)
	defer up.Close()
	g := testGateway(t, up.URL)

	doChat(t, g, "alk_test", "Summarize Q2 revenue trends.")        // ok path
	doChat(t, g, "alk_block", "key is AKIAIOSFODNN7EXAMPLE please") // blocked_dlp

	if got := g.metrics.count.Load(); got < 2 {
		t.Fatalf("expected >=2 observed requests, got %d", got)
	}
	if got := g.metrics.reqOK.Load(); got < 1 {
		t.Fatalf("expected >=1 ok request, got %d", got)
	}
	if got := g.metrics.reqBlocked.Load(); got < 1 {
		t.Fatalf("expected >=1 blocked request, got %d", got)
	}
}
