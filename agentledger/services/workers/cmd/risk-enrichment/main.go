// risk-enrichment — the semantic risk tier (Phase 6, deferred from P5). It reads
// per-run tool/MCP call sequences from agent_tool_calls, asks an LLM to classify
// behavioral risk the deterministic tier can't (suspected injection, data egress,
// anomalous sequences), and writes the findings as governed risk_events.
//
// Opt-in and async by design (never on any inline path): the enrichment loop runs
// only when AGENTLEDGER_RISK_ENRICH_ENABLED=true and ANTHROPIC_API_KEY is set —
// otherwise the process serves health endpoints and does nothing, so it is safe
// to deploy disabled and gate on the deterministic tier's precision (ADR-027/030).
//
//	agent_tool_calls (sequences) ─▶ [risk-enrichment + LLM] ─▶ risk_events (semantic_*)
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/agentledger/workers/internal/riskenrich"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	ch := riskenrich.NewHTTPClient(
		env("AGENTLEDGER_CLICKHOUSE_URL", "http://localhost:8123"),
		env("AGENTLEDGER_CLICKHOUSE_DB", "agentledger"),
		env("AGENTLEDGER_CLICKHOUSE_USER", "default"),
		os.Getenv("AGENTLEDGER_CLICKHOUSE_PASSWORD"),
	)

	metrics := &riskenrich.Metrics{}
	enabled := os.Getenv("AGENTLEDGER_RISK_ENRICH_ENABLED") == "true"
	apiKey := os.Getenv("ANTHROPIC_API_KEY")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, req *http.Request) {
		pingCtx, c := context.WithTimeout(req.Context(), 2*time.Second)
		defer c()
		if err := ch.Ping(pingCtx); err != nil {
			http.Error(w, `{"status":"clickhouse unreachable"}`, http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		writeMetrics(w, metrics)
	})
	srv := &http.Server{Addr: env("AGENTLEDGER_WORKER_ADDR", ":8100"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("admin server error", "err", err)
		}
	}()

	switch {
	case !enabled:
		slog.Warn("semantic risk enrichment disabled (set AGENTLEDGER_RISK_ENRICH_ENABLED=true to enable); serving health only")
	case apiKey == "":
		slog.Warn("ANTHROPIC_API_KEY not set; semantic risk enrichment cannot run; serving health only")
	default:
		cfg := riskenrich.Config{
			LookbackHours: int(envInt("AGENTLEDGER_RISK_ENRICH_LOOKBACK_HOURS", 24)),
			MinCalls:      int(envInt("AGENTLEDGER_RISK_ENRICH_MIN_CALLS", 2)),
			MinConfidence: envFloat("AGENTLEDGER_RISK_ENRICH_MIN_CONFIDENCE", 0.5),
		}
		classifier := riskenrich.NewAnthropicClassifier(
			apiKey,
			env("AGENTLEDGER_RISK_ENRICH_MODEL", "claude-opus-4-8"),
			env("AGENTLEDGER_ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
		)
		e := riskenrich.New(ch, classifier, cfg, metrics)
		interval := time.Duration(envInt("AGENTLEDGER_RISK_ENRICH_INTERVAL_SEC", 3600)) * time.Second
		go runLoop(ctx, e, interval)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down")
	cancel()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}

func runLoop(ctx context.Context, e *riskenrich.Engine, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		slog.Info("enrichment pass starting")
		if err := e.Run(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("enrichment pass error", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func writeMetrics(w http.ResponseWriter, m *riskenrich.Metrics) {
	type row struct {
		name, help string
		val        int64
	}
	for _, mt := range []row{
		{"risk_enrich_runs_total", "Enrichment passes executed.", m.Runs.Load()},
		{"risk_enrich_behaviors_total", "Run behaviors classified.", m.BehaviorsScanned.Load()},
		{"risk_enrich_findings_total", "Semantic risk events written.", m.FindingsRaised.Load()},
		{"risk_enrich_errors_total", "Classifier calls that failed.", m.ClassifyErrors.Load()},
	} {
		_, _ = w.Write([]byte("# HELP " + mt.name + " " + mt.help + "\n# TYPE " + mt.name + " counter\n" +
			mt.name + " " + strconv.FormatInt(mt.val, 10) + "\n"))
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}
