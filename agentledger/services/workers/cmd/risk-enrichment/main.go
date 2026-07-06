// risk-enrichment — the semantic risk tier (Phase 6, deferred from P5). It reads
// per-run tool/MCP call sequences from agent_tool_calls, asks an LLM to classify
// behavioral risk the deterministic tier can't (suspected injection, data egress,
// anomalous sequences), and writes the findings as governed risk_events.
//
// Opt-in and async by design (never on any inline path): the enrichment loop runs
// only when BADGERIQ_RISK_ENRICH_ENABLED=true — otherwise the process serves
// health endpoints and does nothing, so it is safe to deploy disabled and gate on
// the deterministic tier's precision (ADR-027/030).
//
// Inference runs against BadgerIQ's own self-hosted model over an OpenAI-compatible
// endpoint (BADGERIQ_LLM_BASE_URL); no external AI API is called (ADR-050).
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

	"github.com/badgeriq/workers/internal/riskenrich"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	ch := riskenrich.NewHTTPClient(
		env("BADGERIQ_CLICKHOUSE_URL", "http://localhost:8123"),
		env("BADGERIQ_CLICKHOUSE_DB", "agentledger"),
		env("BADGERIQ_CLICKHOUSE_USER", "default"),
		lookupEnv("BADGERIQ_CLICKHOUSE_PASSWORD"),
	)

	metrics := &riskenrich.Metrics{}
	llmMetrics := &riskenrich.LLMMetrics{}
	enabled := lookupEnv("BADGERIQ_RISK_ENRICH_ENABLED") == "true"

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
		writeMetrics(w, metrics, llmMetrics)
	})
	srv := &http.Server{Addr: env("BADGERIQ_WORKER_ADDR", ":8100"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("admin server error", "err", err)
		}
	}()

	if !enabled {
		slog.Warn("semantic risk enrichment disabled (set BADGERIQ_RISK_ENRICH_ENABLED=true to enable); serving health only")
	} else {
		cfg := riskenrich.Config{
			LookbackHours: envIntLocal("BADGERIQ_RISK_ENRICH_LOOKBACK_HOURS", 24),
			MinCalls:      envIntLocal("BADGERIQ_RISK_ENRICH_MIN_CALLS", 2),
			MinConfidence: envFloat("BADGERIQ_RISK_ENRICH_MIN_CONFIDENCE", 0.5),
		}
		baseURL := env("BADGERIQ_LLM_BASE_URL", "http://localhost:8000")
		model := env("BADGERIQ_LLM_MODEL", "badger-ai-8b")
		llm := riskenrich.NewOpenAICompatibleClient(
			baseURL,
			model,
			lookupEnv("BADGERIQ_LLM_API_KEY"),
			time.Duration(envInt("BADGERIQ_LLM_TIMEOUT_S", 60))*time.Second,
			llmMetrics,
		)
		classifier := riskenrich.NewLLMClassifier(llm, envIntLocal("BADGERIQ_AI_MAX_TOKENS", 2000), llmMetrics)
		e := riskenrich.New(ch, classifier, cfg, metrics)
		interval := time.Duration(envInt("BADGERIQ_RISK_ENRICH_INTERVAL_SEC", 3600)) * time.Second
		slog.Info("semantic risk enrichment enabled", "base_url", baseURL, "model", model)
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

func writeMetrics(w http.ResponseWriter, m *riskenrich.Metrics, llm *riskenrich.LLMMetrics) {
	type row struct {
		name, help string
		val        int64
	}
	// Aggregate counters only — never any request/response body (ADR-050).
	for _, mt := range []row{
		{"risk_enrich_runs_total", "Enrichment passes executed.", m.Runs.Load()},
		{"risk_enrich_behaviors_total", "Run behaviors classified.", m.BehaviorsScanned.Load()},
		{"risk_enrich_findings_total", "Semantic risk events written.", m.FindingsRaised.Load()},
		{"risk_enrich_errors_total", "Classifier calls that failed.", m.ClassifyErrors.Load()},
		{"risk_enrich_llm_requests_total", "LLM chat requests attempted.", llm.Requests.Load()},
		{"risk_enrich_llm_retries_total", "LLM request retries (5xx/timeout).", llm.Retries.Load()},
		{"risk_enrich_llm_failures_total", "LLM requests that failed after retries.", llm.Failures.Load()},
		{"risk_enrich_llm_malformed_total", "LLM responses that failed parse/validate.", llm.Malformed.Load()},
		{"risk_enrich_llm_fallbacks_total", "Classifications that fell back to empty.", llm.Fallbacks.Load()},
		{"risk_enrich_llm_prompt_tokens_total", "Prompt tokens reported by the server.", llm.PromptTokens.Load()},
		{"risk_enrich_llm_completion_tokens_total", "Completion tokens reported by the server.", llm.CompletionTokens.Load()},
		{"risk_enrich_llm_latency_ms_total", "Cumulative LLM request latency (ms).", llm.LatencyMsTotal.Load()},
	} {
		_, _ = w.Write([]byte("# HELP " + mt.name + " " + mt.help + "\n# TYPE " + mt.name + " counter\n" +
			mt.name + " " + strconv.FormatInt(mt.val, 10) + "\n"))
	}
}

// lookupEnv resolves an environment variable, preferring BADGERIQ_* and falling back to LEDGERAI_*
// name and falling back to the legacy AGENTLEDGER_* alias (deprecated; kept for
// backwards compatibility — see the README "Renaming to BadgerIQ" note).
func lookupEnv(name string) string {
	const legacy = "AGENTLEDGER_"
	if len(name) > len(legacy) && name[:len(legacy)] == legacy {
		suffix := name[len(legacy):]
		if v := os.Getenv("BADGERIQ_" + suffix); v != "" {
			return v
		}
		if v := os.Getenv("LEDGERAI_" + suffix); v != "" {
			return v
		}
	}
	return os.Getenv(name)
}

func env(key, def string) string {
	if v := lookupEnv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int64) int64 {
	if v := lookupEnv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func envIntLocal(key string, def int) int {
	if v := lookupEnv(key); v != "" {
		n, err := strconv.ParseInt(v, 10, 0)
		if err == nil {
			return int(n)
		}
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v := lookupEnv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}
