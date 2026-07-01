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

// lookupEnv resolves an environment variable, preferring BADGERIQ_* and falling back to LEDGERAI_*
// name and falling back to the legacy AGENTLEDGER_* alias (deprecated; kept for
// backwards compatibility — see the README "Renaming to BadgerIQ" note). Used
// only for the gateway's own config env vars; operator-named env vars (Redis
// password, provider API keys) are read by their exact configured name.
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

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfgPath := lookupEnv("AGENTLEDGER_CONFIG")
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

	budgetCfg := loadBudgetConfig()
	slog.Info("budget config",
		"default_reserve_usd", budgetCfg.defaultReserveUSD,
		"fail_mode", failModeLabel(budgetCfg.failClosed))

	var budgets BudgetStore
	if cfg.Redis.Addr != "" {
		password := ""
		if cfg.Redis.PasswordEnv != "" {
			password = os.Getenv(cfg.Redis.PasswordEnv)
		}
		rb, err := NewRedisBudgetStore(cfg.Redis.Addr, password, cfg.Redis.DB, cfg.VirtualKeys,
			func(key, month string, usd float64) {
				slog.Info("budget.drain", "key", key, "month", month, "spend_usd", usd)
			}, budgetCfg.failClosed)
		if err != nil {
			slog.Error("redis budget store init failed", "err", err)
			os.Exit(1)
		}
		budgets = rb
		slog.Info("budget store: redis", "addr", cfg.Redis.Addr)
	} else {
		budgets = NewBudgetStore(cfg.VirtualKeys)
		slog.Info("budget store: memory (not shared across replicas)")
	}
	defer func() { _ = budgets.Close() }()

	// Event sink: optional disk spool + fail mode come from the environment
	// (secrets-free config); both default to the safe, observe-only behavior.
	if v := lookupEnv("AGENTLEDGER_EVENT_SPOOL_DIR"); v != "" {
		cfg.Events.SpoolDir = v
	}
	if v := lookupEnv("AGENTLEDGER_EVENT_FAIL_MODE"); v != "" {
		cfg.Events.FailMode = v
	}
	sink := NewEventSink(cfg.Events)
	defer sink.Close()

	gw := newGateway(cfg, priceBook, budgets, sink)
	gw.budgetCfg = budgetCfg

	// Optional Postgres config hot-reload. When AGENTLEDGER_PG_DSN is set the
	// gateway loads virtual_keys, DLP policies, and the per-agent tool/MCP
	// allowlist from Postgres and refreshes them every 30 s. On failure it
	// serves the last-known-good snapshot.
	if pgDSN := lookupEnv("AGENTLEDGER_PG_DSN"); pgDSN != "" {
		cs, err := NewPGConfigStore(pgDSN, cfg)
		if err != nil {
			slog.Error("pg config store init failed", "err", err)
			os.Exit(1)
		}
		defer func() { _ = cs.Close() }()
		// Best-effort initial load; fall back to file config on error.
		if pgCfg, loadErr := cs.Load(context.Background()); loadErr == nil {
			gw.current.Store(newSnapshotFromHashed(pgCfg, priceBook))
			slog.Info("initial config loaded from postgres", "keys", len(pgCfg.VirtualKeys))
		} else {
			slog.Warn("initial postgres config load failed; using file config", "err", loadErr)
		}
		reloadCtx, cancelReload := context.WithCancel(context.Background())
		defer cancelReload()
		StartHotReload(reloadCtx, cs, 30*time.Second, gw)
		slog.Info("config hot-reload enabled", "interval", "30s")
	}

	// Ops endpoints (/v1/usage, /metrics) expose spend/usage internals — gate them
	// behind a bearer token. Secret comes from the environment, never config files.
	gw.ops = loadOpsAuthConfig()
	logOpsAuthStartup(gw.ops)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat/completions", gw.handleChatCompletions)
	mux.HandleFunc("POST /v1/messages", gw.handleMessages) // Anthropic Messages API
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	// Ops/debug endpoints require the ops token (see guardOps).
	mux.HandleFunc("GET /v1/usage", gw.guardOps(false, gw.handleUsage))
	// Prometheus policy-overhead histogram + request counters.
	mux.HandleFunc("GET /metrics", gw.guardOps(true, gw.handleMetrics))

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

// failModeLabel renders the budget fail mode for logging.
func failModeLabel(failClosed bool) string {
	if failClosed {
		return "closed"
	}
	return "open"
}

// handleUsage exposes in-memory budget counters for ops/debug.
func (g *Gateway) handleUsage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(g.budgets.Snapshot())
}

// handleMetrics renders the Prometheus policy-overhead histogram + request
// counters, plus event-sink reliability counters.
func (g *Gateway) handleMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	g.metrics.WritePrometheus(w)
	if g.sink != nil {
		g.sink.WriteMetrics(w)
	}
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
