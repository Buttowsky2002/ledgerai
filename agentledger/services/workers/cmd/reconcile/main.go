// reconcile — diffs gateway-observed cost against provider-billed cost (imported
// by the connectors) and books per-day/model adjustments, flagging drift over a
// threshold (default 2%).
//
//	llm_calls (source=gateway) ┐
//	                           ├─▶ v_cost_reconciliation ─▶ [reconcile] ─▶ cost_adjustments
//	provider_costs (connectors)┘
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

	"github.com/agentledger/workers/internal/reconcile"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	ch := reconcile.NewHTTPClient(
		env("AGENTLEDGER_CLICKHOUSE_URL", "http://localhost:8123"),
		env("AGENTLEDGER_CLICKHOUSE_DB", "agentledger"),
		env("AGENTLEDGER_CLICKHOUSE_USER", "default"),
		lookupEnv("AGENTLEDGER_CLICKHOUSE_PASSWORD"),
	)

	metrics := &reconcile.Metrics{}
	r := reconcile.New(ch, envFloat("AGENTLEDGER_RECONCILE_THRESHOLD", 0.02),
		int(envInt("AGENTLEDGER_RECONCILE_LOOKBACK_DAYS", 35)), metrics)

	interval := time.Duration(envInt("AGENTLEDGER_RECONCILE_INTERVAL_SEC", 86400)) * time.Second

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
	srv := &http.Server{Addr: env("AGENTLEDGER_WORKER_ADDR", ":8093"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("admin server error", "err", err)
		}
	}()

	go runLoop(ctx, r, interval)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down")
	cancel()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}

func runLoop(ctx context.Context, r *reconcile.Reconciler, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		slog.Info("reconciliation pass starting")
		if err := r.Run(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("reconciliation pass error", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func writeMetrics(w http.ResponseWriter, m *reconcile.Metrics) {
	type row struct {
		name, help string
		val        int64
	}
	for _, mt := range []row{
		{"reconcile_runs_total", "Reconciliation passes executed.", m.Runs.Load()},
		{"reconcile_rows_total", "Adjustment rows booked.", m.Reconciled.Load()},
		{"reconcile_flagged_total", "Rows exceeding the drift threshold.", m.Flagged.Load()},
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

func envFloat(key string, def float64) float64 {
	if v := lookupEnv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}
