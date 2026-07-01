// risk-engine — the Agent-Native Risk Engine worker (Phase 5). It observes
// per-agent tool/MCP usage, flags calls outside the deny-by-default allowlist as
// governed risk events, and rolls each agent's exposure into agent_risk, which
// v_roi turns into risk-adjusted ROI.
//
//	agent_tool_calls + agent_tool_allow ─▶ [risk-engine] ─▶ risk_events + agent_risk
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

	"github.com/agentledger/workers/internal/riskengine"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	ch := riskengine.NewHTTPClient(
		env("AGENTLEDGER_CLICKHOUSE_URL", "http://localhost:8123"),
		env("AGENTLEDGER_CLICKHOUSE_DB", "agentledger"),
		env("AGENTLEDGER_CLICKHOUSE_USER", "default"),
		lookupEnv("AGENTLEDGER_CLICKHOUSE_PASSWORD"),
	)

	metrics := &riskengine.Metrics{}
	spikeMin := envUint32("AGENTLEDGER_RISK_SPIKE_MIN", 5)
	e := riskengine.New(ch, spikeMin, metrics)
	interval := time.Duration(envInt("AGENTLEDGER_RISK_INTERVAL_SEC", 3600)) * time.Second

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
	srv := &http.Server{Addr: env("AGENTLEDGER_WORKER_ADDR", ":8099"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("admin server error", "err", err)
		}
	}()

	go runLoop(ctx, e, interval)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down")
	cancel()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}

func runLoop(ctx context.Context, e *riskengine.Engine, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		slog.Info("risk pass starting")
		if err := e.Run(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("risk pass error", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func writeMetrics(w http.ResponseWriter, m *riskengine.Metrics) {
	type row struct {
		name, help string
		val        int64
	}
	for _, mt := range []row{
		{"risk_runs_total", "Risk passes executed.", m.Runs.Load()},
		{"risk_events_total", "Governed risk events written.", m.EventsRaised.Load()},
		{"risk_agents_rated_total", "agent_risk rows written.", m.AgentsRated.Load()},
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

func envUint32(key string, def uint32) uint32 {
	if v := lookupEnv(key); v != "" {
		n, err := strconv.ParseUint(v, 10, 32)
		if err == nil {
			return uint32(n)
		}
	}
	return def
}
