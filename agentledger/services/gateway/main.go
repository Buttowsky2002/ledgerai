// AgentLedger Gateway — thin, low-latency, OpenAI-compatible LLM proxy.
//
// Design principles (see docs/ARCHITECTURE.md):
//   - Inline path stays thin: auth -> policy precheck -> budget check -> proxy.
//   - Everything heavy (classification, enrichment, aggregation) is async.
//   - Stdlib only: no external dependencies on the hot path.
//   - Fail-open or fail-closed per policy when downstream control systems
//     are unavailable.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfgPath := os.Getenv("AGENTLEDGER_CONFIG")
	if cfgPath == "" {
		cfgPath = "config.json"
	}
	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		slog.Error("config load failed", "err", err)
		os.Exit(1)
	}

	priceBook, err := LoadPriceBook(cfg.PriceBookPath)
	if err != nil {
		slog.Error("price book load failed", "err", err)
		os.Exit(1)
	}

	keys := NewKeyStore(cfg.VirtualKeys)
	budgets := NewBudgetStore(cfg.VirtualKeys)
	dlp := NewDLPEngine(cfg.DLP)
	sink := NewEventSink(cfg.Events)
	defer sink.Close()

	gw := &Gateway{
		cfg:       cfg,
		keys:      keys,
		budgets:   budgets,
		dlp:       dlp,
		prices:    priceBook,
		sink:      sink,
		transport: newUpstreamTransport(),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat/completions", gw.handleChatCompletions)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /v1/usage", gw.handleUsage) // debug/ops endpoint

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           withRequestID(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("gateway listening", "addr", cfg.ListenAddr)
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
	slog.Info("gateway stopped")
}

// handleUsage exposes in-memory budget counters for ops/debug.
func (g *Gateway) handleUsage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(g.budgets.Snapshot())
}

// withRequestID assigns a request ID used as call_id in emitted events.
func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = newID("call")
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKeyRequestID{}, id)))
	})
}

type ctxKeyRequestID struct{}

func requestIDFrom(ctx context.Context) string {
	if v, ok := ctx.Value(ctxKeyRequestID{}).(string); ok {
		return v
	}
	return newID("call")
}
