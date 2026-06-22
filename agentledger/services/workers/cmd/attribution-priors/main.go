// attribution-priors — the attribution flywheel (build-plan sub-phase 3.6). Nightly
// it pools deterministic-labeled training data across OPTED-IN tenants and, only
// when ≥ min_customer_n distinct tenants contribute, fits ANONYMIZED aggregate
// priors (a global scorer + per-outcome-type temporal half-lives) into
// attribution_priors — improving cold-start accuracy for new tenants.
//
// PRIVACY (ADR-044, CLAUDE.md §7): priors are aggregates only, gated by
// min_customer_n; attribution_priors has no tenant_id; opt-out is honored. This is
// a separate worker from the attribution engine and, like it, is not deployed by
// default (it activates with the ATTRIBUTION_ENGINE_V2 rollout).
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

	"github.com/agentledger/workers/internal/attribution"
	"github.com/agentledger/workers/internal/attrpriors"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	dsn := os.Getenv("AGENTLEDGER_PG_DSN")
	if dsn == "" {
		slog.Error("AGENTLEDGER_PG_DSN is required")
		os.Exit(1)
	}
	pg, err := attribution.NewPG(dsn)
	if err != nil {
		slog.Error("postgres open", "err", err)
		os.Exit(1)
	}
	defer func() { _ = pg.Close() }()

	ch := attribution.NewHTTPClient(
		env("AGENTLEDGER_CLICKHOUSE_URL", "http://localhost:8123"),
		env("AGENTLEDGER_CLICKHOUSE_DB", "agentledger"),
		env("AGENTLEDGER_CLICKHOUSE_USER", "default"),
		os.Getenv("AGENTLEDGER_CLICKHOUSE_PASSWORD"),
	)

	metrics := &attrpriors.Metrics{}
	runner := attrpriors.NewRunner(ch, pg,
		time.Duration(envInt("AGENTLEDGER_ATTR_WINDOW_MIN", 240))*time.Minute,
		int(envInt("AGENTLEDGER_PRIORS_LOOKBACK_DAYS", 90)),
		int(envInt("AGENTLEDGER_PRIORS_MIN_CUSTOMER_N", int64(attrpriors.DefaultMinCustomerN))),
		metrics)

	interval := time.Duration(envInt("AGENTLEDGER_PRIORS_INTERVAL_SEC", 86400)) * time.Second
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
		if err := pg.Ping(pingCtx); err != nil {
			http.Error(w, `{"status":"postgres unreachable"}`, http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		writeMetrics(w, metrics)
	})
	srv := &http.Server{Addr: env("AGENTLEDGER_WORKER_ADDR", ":8102"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("admin server error", "err", err)
		}
	}()

	go runLoop(ctx, runner, interval)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down")
	cancel()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}

func runLoop(ctx context.Context, r *attrpriors.Runner, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		slog.Info("attribution flywheel pass starting")
		if err := r.Run(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("attribution flywheel pass error", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func writeMetrics(w http.ResponseWriter, m *attrpriors.Metrics) {
	for _, mt := range []struct {
		name, help string
		val        int64
	}{
		{"attribution_priors_passes_total", "Flywheel passes executed.", m.Passes.Load()},
		{"attribution_priors_opted_in_tenants", "Opted-in tenants on the last pass.", m.OptedIn.Load()},
		{"attribution_priors_contributing_tenants", "Tenants contributing labeled data on the last pass.", m.Contributed.Load()},
		{"attribution_priors_produced_total", "Passes that cleared min_customer_n and emitted priors.", m.Produced.Load()},
	} {
		_, _ = w.Write([]byte("# HELP " + mt.name + " " + mt.help + "\n# TYPE " + mt.name + " gauge\n" +
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
