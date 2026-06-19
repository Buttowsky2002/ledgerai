// LiteLLM ingestion adapter — a webhook that turns LiteLLM spend logs into
// AgentLedger canonical events.
//
// Point LiteLLM's logging callback (or a job replaying /spend/logs) at
// POST /ingest/litellm. The adapter normalizes each record and forwards the
// batch to the collector's /v1/events, which schema-validates and produces it
// to Redpanda. The adapter holds no state and never blocks LiteLLM for long:
// it forwards synchronously with a bounded timeout and reports a summary.
//
// See docs/ADRs/023-litellm-adapter.md and the module README for the format
// assumptions and the deliberate "normalize here, validate at the collector"
// split.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/agentledger/ingest-adapters/internal/forward"
	"github.com/agentledger/ingest-adapters/internal/litellm"
)

type config struct {
	addr          string
	collectorURL  string
	defaultTenant string
	tenantMetaKey string
	maxBodyBytes  int64
}

func loadConfig() config {
	return config{
		addr:          env("AGENTLEDGER_LITELLM_ADAPTER_ADDR", ":8097"),
		collectorURL:  env("AGENTLEDGER_COLLECTOR_URL", "http://localhost:8090/v1/events"),
		defaultTenant: os.Getenv("AGENTLEDGER_ADAPTER_TENANT"),
		tenantMetaKey: env("AGENTLEDGER_ADAPTER_TENANT_META_KEY", "agentledger_tenant_id"),
		maxBodyBytes:  envInt64("AGENTLEDGER_MAX_BODY_BYTES", 8<<20),
	}
}

type metrics struct {
	requests      atomic.Int64
	received      atomic.Int64 // records read from requests
	normalized    atomic.Int64
	rejected      atomic.Int64 // records that failed normalization
	forwarded     atomic.Int64 // events accepted by the collector
	forwardErrors atomic.Int64
}

type server struct {
	cfg     config
	fwd     *forward.Client
	metrics *metrics
}

// ingestResult summarizes one webhook call.
type ingestResult struct {
	Received   int `json:"received"`
	Normalized int `json:"normalized"`
	Rejected   int `json:"rejected"`
	Forwarded  int `json:"forwarded"`
}

// handleLiteLLM accepts a single spend-log object or a JSON array of them.
func (s *server) handleLiteLLM(w http.ResponseWriter, r *http.Request) {
	s.metrics.requests.Add(1)
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.cfg.maxBodyBytes))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "could not read body"})
		return
	}
	recs, err := decodeRecords(body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if len(recs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no records in request"})
		return
	}
	s.metrics.received.Add(int64(len(recs)))

	events, errs := litellm.NormalizeBatch(recs, litellm.Config{
		DefaultTenant: s.cfg.defaultTenant,
		TenantMetaKey: s.cfg.tenantMetaKey,
	})
	s.metrics.normalized.Add(int64(len(events)))
	s.metrics.rejected.Add(int64(len(errs)))
	for _, e := range errs {
		slog.Warn("litellm record rejected", "err", e)
	}

	res := ingestResult{Received: len(recs), Normalized: len(events), Rejected: len(errs)}

	if len(events) > 0 {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		if err := s.fwd.Send(ctx, events); err != nil {
			s.metrics.forwardErrors.Add(1)
			slog.Error("forward to collector failed", "err", err, "events", len(events))
			// 502: we normalized fine but the downstream is unavailable; LiteLLM
			// (or the replay job) should retry the batch.
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "collector unavailable", "result": res})
			return
		}
		s.metrics.forwarded.Add(int64(len(events)))
		res.Forwarded = len(events)
	}

	// 202 when anything was forwarded; 422 when every record was unmappable.
	status := http.StatusAccepted
	if len(events) == 0 {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, res)
}

// decodeRecords parses a single object or a JSON array of spend-log records.
func decodeRecords(body []byte) ([]litellm.SpendLog, error) {
	for i := 0; i < len(body); i++ {
		switch body[i] {
		case ' ', '\t', '\r', '\n':
			continue
		case '[':
			var arr []litellm.SpendLog
			if err := json.Unmarshal(body, &arr); err != nil {
				return nil, fmt.Errorf("invalid JSON array of spend logs")
			}
			return arr, nil
		default:
			var one litellm.SpendLog
			if err := json.Unmarshal(body, &one); err != nil {
				return nil, fmt.Errorf("invalid spend-log JSON")
			}
			return []litellm.SpendLog{one}, nil
		}
	}
	return nil, nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg := loadConfig()
	s := &server{cfg: cfg, fwd: forward.New(cfg.collectorURL), metrics: &metrics{}}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /ingest/litellm", s.handleLiteLLM)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})
	mux.HandleFunc("GET /metrics", s.writeMetrics)

	srv := &http.Server{Addr: cfg.addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		slog.Info("litellm adapter listening", "addr", cfg.addr, "collector", cfg.collectorURL,
			"default_tenant_set", cfg.defaultTenant != "")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	slog.Info("litellm adapter stopped")
}

func (s *server) writeMetrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	m := s.metrics
	for _, mt := range []struct {
		name, help string
		val        int64
	}{
		{"litellm_adapter_requests_total", "Webhook requests received.", m.requests.Load()},
		{"litellm_adapter_records_received_total", "Spend-log records read.", m.received.Load()},
		{"litellm_adapter_records_normalized_total", "Records mapped to canonical events.", m.normalized.Load()},
		{"litellm_adapter_records_rejected_total", "Records that failed normalization.", m.rejected.Load()},
		{"litellm_adapter_events_forwarded_total", "Events accepted by the collector.", m.forwarded.Load()},
		{"litellm_adapter_forward_errors_total", "Failed forwards to the collector.", m.forwardErrors.Load()},
	} {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", mt.name, mt.help, mt.name, mt.name, mt.val)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt64(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		var n int64
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
			return n
		}
	}
	return def
}
