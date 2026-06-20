package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"sync"
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
	Status     string `json:"status"` // ok | upstream_error | blocked_dlp | blocked_budget | blocked_rate

	// risk
	PromptHash   string    `json:"prompt_hash"`
	DLPAction    string    `json:"dlp_action"` // allow|log|warn|redact|block
	DLPFindings  []Finding `json:"dlp_findings,omitempty"`
	RiskSeverity string    `json:"risk_severity,omitempty"`
	Streamed     bool      `json:"streamed"`
}

// EventSink buffers events and flushes them asynchronously so the hot
// path never blocks on analytics infrastructure. Production sink target
// is the ingest collector (HTTP) in front of Redpanda/Kafka; the same
// JSONEachRow payload can also be POSTed directly to ClickHouse.
type EventSink struct {
	cfg  EventSinkCfg
	ch   chan LLMCallEvent
	wg   sync.WaitGroup
	file *os.File
}

// NewEventSink starts the asynchronous event sink described by cfg: it opens the
// spool file for the "file" type and launches the background flush loop.
func NewEventSink(cfg EventSinkCfg) *EventSink {
	s := &EventSink{cfg: cfg, ch: make(chan LLMCallEvent, cfg.BufferSize)}
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

// Emit never blocks: if the buffer is full, the event is dropped and
// counted (billing reconciliation from provider exports backstops loss).
func (s *EventSink) Emit(e LLMCallEvent) {
	select {
	case s.ch <- e:
	default:
		slog.Warn("event buffer full, dropping event", "call_id", e.CallID)
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
	switch s.cfg.Type {
	case "http":
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.URL, bytes.NewReader(buf.Bytes()))
		if err == nil {
			req.Header.Set("Content-Type", "application/x-ndjson")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				slog.Error("event flush failed", "err", err, "n", len(batch))
				return
			}
			_ = resp.Body.Close()
		}
	case "file":
		if s.file != nil {
			_, _ = s.file.Write(buf.Bytes())
			return
		}
		fallthrough
	default:
		_, _ = os.Stdout.Write(buf.Bytes())
	}
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
