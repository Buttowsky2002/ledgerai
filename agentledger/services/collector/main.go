// BadgerIQ Collector — HTTP ingest for SDK and gateway events.
//
// Responsibilities (see CLAUDE_CODE_BUILD_SPEC.md §3, Phase 1):
//   - Accept events over HTTP (single object, JSON array, or NDJSON).
//   - Validate against the canonical schema (schemas/events/).
//   - Produce valid events to the Redpanda topic events.raw, keyed by tenant.
//   - Return 202 on accept; 429 on backpressure. Never block the caller.
//
// The collector is stateless and horizontally scalable; durability lives in
// the event bus. Dropped/failed records are counted, never silent (rule 11).
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg := LoadConfig()

	validator, err := NewValidator(cfg.SchemaPath)
	if err != nil {
		slog.Error("schema load failed", "err", err, "path", cfg.SchemaPath)
		os.Exit(1)
	}

	producer, err := NewKafkaProducer(cfg.Brokers, cfg.Topic, cfg.MaxInflight)
	if err != nil {
		slog.Error("producer init failed", "err", err)
		os.Exit(1)
	}
	defer producer.Close()

	metrics := &Metrics{}
	c := &Collector{
		validator:         validator,
		producer:          producer,
		metrics:           metrics,
		maxBatch:          cfg.MaxBatch,
		otelTenantAttr:    cfg.OtelTenantAttr,
		otelDefaultTenant: cfg.OtelDefaultTenant,
	}

	mux := http.NewServeMux()
	mux.Handle("POST /v1/events", limitBody(http.HandlerFunc(c.handleEvents), cfg.MaxBodyBytes))
	// OTel GenAI: accept OTLP/JSON traces from any instrumented stack.
	mux.Handle("POST /v1/ingest/otel", limitBody(http.HandlerFunc(c.handleOTel), cfg.MaxBodyBytes))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !producer.Ready() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "event bus unreachable"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		metrics.WritePrometheus(w, producer)
	})

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("collector listening", "addr", cfg.ListenAddr, "topic", cfg.Topic, "brokers", cfg.Brokers)
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
	slog.Info("collector stopped")
}

// limitBody bounds the request body size (rule 5: validate at the boundary).
func limitBody(next http.Handler, max int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, max)
		next.ServeHTTP(w, r)
	})
}
