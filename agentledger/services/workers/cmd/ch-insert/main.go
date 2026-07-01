// ch-insert — consumes the events.raw topic and batch-inserts events into
// ClickHouse via the HTTP JSONEachRow interface.
//
// Pipeline position (CLAUDE_CODE_BUILD_SPEC.md §3, Phase 1):
//
//	collector ──▶ events.raw (Redpanda) ──▶ [ch-insert] ──▶ ClickHouse
//	                                              └──▶ events.dlq (poison rows)
//
// Offsets commit only after a batch is durably inserted, so a crash re-delivers
// rather than loses events; ClickHouse ReplacingMergeTree dedups any overlap.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/badgeriq/workers/internal/chinsert"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg := chinsert.LoadConfig()

	inserter := chinsert.NewHTTPInserter(cfg.ClickHouseURL, cfg.ClickHouseDB, cfg.ClickHouseUser, cfg.ClickHousePassword)

	dlq, err := chinsert.NewKafkaDLQ(cfg.Brokers, cfg.DLQTopic)
	if err != nil {
		slog.Error("dlq producer init failed", "err", err)
		os.Exit(1)
	}
	defer dlq.Close()

	metrics := &chinsert.Metrics{}
	pipeline := chinsert.NewPipeline(inserter, dlq, metrics, cfg.InsertRetries, cfg.RetryBackoff)

	consumer, err := chinsert.NewConsumer(cfg.Brokers, cfg.Topic, cfg.ConsumerGroup, pipeline, cfg.RetryBackoff)
	if err != nil {
		slog.Error("consumer init failed", "err", err)
		os.Exit(1)
	}
	defer consumer.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Health / readiness / metrics endpoint (observability on every service).
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		pingCtx, c := context.WithTimeout(r.Context(), 2*time.Second)
		defer c()
		if err := inserter.Ping(pingCtx); err != nil {
			http.Error(w, `{"status":"clickhouse unreachable"}`, http.StatusServiceUnavailable)
			return
		}
		if err := consumer.Ping(pingCtx); err != nil {
			http.Error(w, `{"status":"broker unreachable"}`, http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		metrics.WritePrometheus(w)
	})
	srv := &http.Server{Addr: cfg.ListenAddr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("admin server error", "err", err)
		}
	}()

	go func() {
		slog.Info("ch-insert consuming", "topic", cfg.Topic, "group", cfg.ConsumerGroup,
			"clickhouse", cfg.ClickHouseURL)
		consumer.Run(ctx)
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down")
	cancel()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}
