package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// LLMCallEvent is the canonical activity record — one row per gateway
// call, aligned with the ClickHouse llm_calls table and exportable to
// FOCUS 1.2 (x_ai_* extension columns). Attribute names track the
// OpenTelemetry GenAI semantic conventions (gen_ai.*) where they exist.
//
// Privacy: no raw prompt/response content. prompt_hash supports
// dedup/cache analysis; DLP results are categorical only.
type LLMCallEvent struct {
	CallID    string    `json:"call_id"`
	Timestamp time.Time `json:"ts"`

	// attribution dimensions
	TenantID    string `json:"tenant_id"`
	TeamID      string `json:"team_id"`
	UserID      string `json:"user_id"`
	AppID       string `json:"app_id"`
	Environment string `json:"environment"`
	VirtualKey  string `json:"virtual_key_id"`

	// agent context (propagated via headers from SDK)
	AgentID string `json:"agent_id,omitempty"`
	RunID   string `json:"run_id,omitempty"`
	StepID  string `json:"step_id,omitempty"`

	// gen_ai.* aligned
	Provider      string `json:"provider"`       // gen_ai.provider.name
	RequestModel  string `json:"request_model"`  // gen_ai.request.model
	ResponseModel string `json:"response_model"` // gen_ai.response.model
	OperationName string `json:"operation_name"` // gen_ai.operation.name = "chat"

	// usage + cost
	InputTokens      int     `json:"input_tokens"`
	OutputTokens     int     `json:"output_tokens"`
	CacheReadTokens  int     `json:"cache_read_tokens"`
	CacheWriteTokens int     `json:"cache_write_tokens"`
	CostUSD          float64 `json:"cost_usd"`

	// performance + outcome of the call itself
	LatencyMs  int64  `json:"latency_ms"`
	StatusCode int    `json:"status_code"`
	Status     string `json:"status"` // ok | upstream_error | client_error | blocked_dlp | blocked_budget | blocked_rate | blocked_policy | blocked_tool | blocked_injection

	// risk
	PromptHash        string             `json:"prompt_hash"`
	DLPAction         string             `json:"dlp_action"` // allow|log|warn|redact|block
	DLPFindings       []Finding          `json:"dlp_findings,omitempty"`
	InjectionAction   string             `json:"injection_action,omitempty"`   // block|redact|flag|log|allow
	InjectionFindings []InjectionFinding `json:"injection_findings,omitempty"` // metadata only — never raw content
	RiskSeverity      string             `json:"risk_severity,omitempty"`
	Streamed          bool               `json:"streamed"`
}

// flushBucketsMs are cumulative histogram upper bounds for flush duration.
var flushBucketsMs = [...]float64{5, 10, 25, 50, 100, 250, 500, 1000, 5000}

// errFlushRejected marks a flush the sink reached but the server refused (non-2xx).
var errFlushRejected = errors.New("event flush rejected (non-2xx)")

// spoolSeq disambiguates spool filenames written within the same nanosecond.
var spoolSeq atomic.Int64

// strictEnqueueWait bounds how long Emit applies backpressure in strict mode
// before giving up and counting a drop.
const strictEnqueueWait = 250 * time.Millisecond

// EventSink buffers events and flushes them asynchronously so the hot path never
// blocks on analytics infrastructure. Production sink target is the ingest
// collector (HTTP) in front of Redpanda/Kafka; the same JSONEachRow payload can
// also be POSTed directly to ClickHouse.
//
// Reliability: HTTP flushes use an owned client with a bounded timeout, check the
// response status (non-2xx is a rejection, never success), retry transient
// failures with small bounded backoff, and optionally spool failed batches to
// disk. Loss is always measurable via the ledgerai_events_* counters.
type EventSink struct {
	cfg      EventSinkCfg
	ch       chan LLMCallEvent
	wg       sync.WaitGroup
	file     *os.File
	client   *http.Client
	strict   bool
	spoolDir string
	retries  int

	// metrics (atomic, lock-free)
	emitted        atomic.Int64
	dropped        atomic.Int64
	flushErrors    atomic.Int64
	flushRejected  atomic.Int64
	flushDurBucket [len(flushBucketsMs)]atomic.Int64
	flushDurMicros atomic.Int64
	flushDurCount  atomic.Int64
}

// NewEventSink starts the asynchronous event sink described by cfg: it opens the
// spool file for the "file" type and launches the background flush loop.
func NewEventSink(cfg EventSinkCfg) *EventSink {
	timeout := 30 * time.Second
	if cfg.TimeoutMs > 0 {
		timeout = time.Duration(cfg.TimeoutMs) * time.Millisecond
	}
	retries := cfg.Retries
	if retries < 0 {
		retries = 0
	}
	s := &EventSink{
		cfg:      cfg,
		ch:       make(chan LLMCallEvent, cfg.BufferSize),
		client:   &http.Client{Timeout: timeout},
		strict:   strings.EqualFold(cfg.FailMode, "strict"),
		spoolDir: cfg.SpoolDir,
		retries:  retries,
	}
	if cfg.Type == "file" && cfg.Path != "" {
		f, err := os.OpenFile(cfg.Path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			slog.Error("event sink file open failed, falling back to stdout", "err", err)
		} else {
			s.file = f
		}
	}
	s.wg.Add(1)
	go s.run()
	return s
}

// Emit enqueues an event for asynchronous flushing and reports whether it was
// accepted. In observe-only mode (default) a full buffer drops immediately and
// is counted. In strict mode Emit applies bounded backpressure to minimize loss
// before giving up; it still counts the drop and returns false so billing/audit
// callers can react.
func (s *EventSink) Emit(e LLMCallEvent) bool {
	if s.strict {
		t := time.NewTimer(strictEnqueueWait)
		defer t.Stop()
		select {
		case s.ch <- e:
			s.emitted.Add(1)
			return true
		case <-t.C:
			s.dropped.Add(1)
			slog.Warn("event buffer full (strict): dropped after backpressure", "call_id", e.CallID)
			return false
		}
	}
	select {
	case s.ch <- e:
		s.emitted.Add(1)
		return true
	default:
		s.dropped.Add(1)
		slog.Warn("event buffer full, dropping event", "call_id", e.CallID)
		return false
	}
}

func (s *EventSink) run() {
	defer s.wg.Done()
	ticker := time.NewTicker(time.Duration(s.cfg.FlushMs) * time.Millisecond)
	defer ticker.Stop()
	batch := make([]LLMCallEvent, 0, 256)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		s.flush(batch)
		batch = batch[:0]
	}
	for {
		select {
		case e, ok := <-s.ch:
			if !ok {
				flush()
				return
			}
			batch = append(batch, e)
			if len(batch) >= 256 {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

func (s *EventSink) flush(batch []LLMCallEvent) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	for _, e := range batch {
		_ = enc.Encode(e) // JSONEachRow: one JSON object per line
	}
	payload := buf.Bytes()

	start := time.Now()
	var err error
	switch s.cfg.Type {
	case "http":
		err = s.flushHTTP(payload, len(batch))
	case "file":
		if s.file != nil {
			_, err = s.file.Write(payload)
		} else {
			_, err = os.Stdout.Write(payload)
		}
	default:
		_, err = os.Stdout.Write(payload)
	}
	s.recordFlushDuration(time.Since(start))

	if err != nil {
		// flushRejected (non-2xx) is already counted inside flushHTTP; only count
		// transport/IO failures here to avoid double counting.
		if !errors.Is(err, errFlushRejected) {
			s.flushErrors.Add(1)
			slog.Error("event flush failed", "err", err, "n", len(batch))
		}
		s.spool(payload) // best-effort durable retry buffer (content-free)
	}
}

// flushHTTP POSTs the batch with a bounded timeout and bounded retry. A non-2xx
// response is a rejection (counted, never treated as success). Transport errors
// and 5xx are retried; 4xx is not.
func (s *EventSink) flushHTTP(payload []byte, n int) error {
	var lastErr error
	for attempt := 0; attempt <= s.retries; attempt++ {
		if attempt > 0 {
			time.Sleep(flushBackoff(attempt))
		}
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, s.cfg.URL, bytes.NewReader(payload))
		if err != nil {
			return err // malformed request — not retryable
		}
		req.Header.Set("Content-Type", "application/x-ndjson")

		resp, err := s.client.Do(req)
		if err != nil {
			lastErr = err // transport error / timeout — retry
			continue
		}
		status := resp.StatusCode
		_ = resp.Body.Close() // always close the body, even though we don't read it

		if status >= 200 && status < 300 {
			return nil
		}
		if status >= 500 && attempt < s.retries {
			lastErr = fmt.Errorf("event sink HTTP %d", status)
			continue // retry server errors
		}
		s.flushRejected.Add(1)
		slog.Error("event flush rejected by sink", "status", status, "n", n)
		return errFlushRejected
	}
	return lastErr
}

// flushBackoff returns a small, bounded backoff for retry attempt (1-indexed).
func flushBackoff(attempt int) time.Duration {
	d := time.Duration(attempt) * 50 * time.Millisecond
	if d > 250*time.Millisecond {
		d = 250 * time.Millisecond
	}
	return d
}

// spool appends a failed batch to disk as ndjson for later replay. The payload is
// the canonical event stream, which by construction carries NO raw prompt/response
// content (prompt_hash + categorical findings only), so spooling is privacy-safe.
func (s *EventSink) spool(payload []byte) {
	if s.spoolDir == "" {
		return
	}
	name := filepath.Join(s.spoolDir,
		fmt.Sprintf("events-%d-%d.ndjson", time.Now().UTC().UnixNano(), spoolSeq.Add(1)))
	// name is built from the operator-configured spoolDir plus a generated
	// filename; it is never derived from request/user input.
	f, err := os.OpenFile(name, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600) //nolint:gosec // G304: path from operator config, not user input
	if err != nil {
		slog.Error("event spool open failed", "err", err)
		return
	}
	defer func() { _ = f.Close() }()
	if _, err := f.Write(payload); err != nil {
		slog.Error("event spool write failed", "err", err)
	}
}

func (s *EventSink) recordFlushDuration(d time.Duration) {
	ms := float64(d.Microseconds()) / 1000.0
	s.flushDurCount.Add(1)
	s.flushDurMicros.Add(d.Microseconds())
	for i, ub := range flushBucketsMs {
		if ms <= ub {
			s.flushDurBucket[i].Add(1)
			return
		}
	}
}

// WriteMetrics renders the event-sink reliability counters in the Prometheus
// text exposition format (appended to the gateway's /metrics output).
func (s *EventSink) WriteMetrics(w io.Writer) {
	counter := func(name, help string, v int64) {
		_, _ = fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", name, help, name, name, v)
	}
	counter("ledgerai_events_emitted_total", "Events accepted into the sink buffer.", s.emitted.Load())
	counter("ledgerai_events_dropped_total", "Events dropped because the buffer was full.", s.dropped.Load())
	counter("ledgerai_event_flush_errors_total", "Flush attempts that failed with a transport/IO error.", s.flushErrors.Load())
	counter("ledgerai_event_flush_rejected_total", "Flush attempts the sink reached but rejected (non-2xx).", s.flushRejected.Load())

	_, _ = fmt.Fprint(w, "# HELP ledgerai_event_flush_duration_ms Event batch flush duration, milliseconds.\n# TYPE ledgerai_event_flush_duration_ms histogram\n")
	var cumulative int64
	for i, ub := range flushBucketsMs {
		cumulative += s.flushDurBucket[i].Load()
		_, _ = fmt.Fprintf(w, "ledgerai_event_flush_duration_ms_bucket{le=\"%g\"} %d\n", ub, cumulative)
	}
	count := s.flushDurCount.Load()
	_, _ = fmt.Fprintf(w, "ledgerai_event_flush_duration_ms_bucket{le=\"+Inf\"} %d\n", count)
	_, _ = fmt.Fprintf(w, "ledgerai_event_flush_duration_ms_sum %g\n", float64(s.flushDurMicros.Load())/1000.0)
	_, _ = fmt.Fprintf(w, "ledgerai_event_flush_duration_ms_count %d\n", count)
}

// Close stops accepting new events, drains the buffer, and waits for the flush
// loop to finish.
func (s *EventSink) Close() {
	close(s.ch)
	s.wg.Wait()
	if s.file != nil {
		_ = s.file.Close()
	}
}
