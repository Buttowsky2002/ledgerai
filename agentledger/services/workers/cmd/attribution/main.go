// attribution — correlates business outcomes to the agent runs that produced
// them (time-window + identity + issue/branch signals), scores an
// attribution_confidence (0..1), and stamps run_id + confidence back onto the
// outcomes table so v_unit_economics can join AI cost to each outcome.
//
//	outcomes (run_id='', confidence=0) ┐
//	                                   ├─▶ [attribution] ─▶ outcomes (run_id, confidence)
//	agent_runs (completed)             ┘
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
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	ch := attribution.NewHTTPClient(
		env("AGENTLEDGER_CLICKHOUSE_URL", "http://localhost:8123"),
		env("AGENTLEDGER_CLICKHOUSE_DB", "agentledger"),
		env("AGENTLEDGER_CLICKHOUSE_USER", "default"),
		os.Getenv("AGENTLEDGER_CLICKHOUSE_PASSWORD"),
	)

	metrics := &attribution.Metrics{}
	window := time.Duration(envInt("AGENTLEDGER_ATTR_WINDOW_MIN", 240)) * time.Minute
	lookbackDays := int(envInt("AGENTLEDGER_ATTR_LOOKBACK_DAYS", 30))
	m := attribution.New(ch, window, lookbackDays,
		envFloat("AGENTLEDGER_ATTR_MIN_CONFIDENCE", 0.3), metrics)

	// Attribution engine v2 (build-plan Phase 3 refactor; ADR-040). Behind the
	// ATTRIBUTION_ENGINE_V2 flag and requiring a Postgres DSN, it runs in SHADOW:
	// it writes rich attribution_edges (Postgres) + attribution_events (ClickHouse)
	// but does NOT stamp outcomes — V1 still owns that until V2 passes the gates.
	var engine *attribution.EngineV2
	var pg *attribution.PG
	v2metrics := &attribution.V2Metrics{}
	if envBool("ATTRIBUTION_ENGINE_V2", false) {
		dsn := os.Getenv("AGENTLEDGER_PG_DSN")
		if dsn == "" {
			slog.Warn("ATTRIBUTION_ENGINE_V2 set but AGENTLEDGER_PG_DSN empty — v2 disabled")
		} else {
			var err error
			if pg, err = attribution.NewPG(dsn); err != nil {
				slog.Error("postgres open", "err", err)
				os.Exit(1)
			}
			defer func() { _ = pg.Close() }()
			engine = attribution.NewEngineV2(ch, pg, window, lookbackDays, v2metrics)
			slog.Info("attribution engine v2 enabled (shadow mode)")
		}
	}

	interval := time.Duration(envInt("AGENTLEDGER_ATTR_INTERVAL_SEC", 900)) * time.Second

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
		if pg != nil {
			if err := pg.Ping(pingCtx); err != nil {
				http.Error(w, `{"status":"postgres unreachable"}`, http.StatusServiceUnavailable)
				return
			}
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		writeMetrics(w, metrics, v2metrics)
	})
	srv := &http.Server{Addr: env("AGENTLEDGER_WORKER_ADDR", ":8096"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("admin server error", "err", err)
		}
	}()

	go runLoop(ctx, m, engine, interval)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down")
	cancel()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}

func runLoop(ctx context.Context, m *attribution.Matcher, engine *attribution.EngineV2, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		slog.Info("attribution pass starting")
		if err := m.Run(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("attribution pass error", "err", err)
		}
		// V2 shadow pass (when enabled): writes edges + events, never stamps outcomes.
		if engine != nil {
			if err := engine.Process(ctx); err != nil {
				if ctx.Err() != nil {
					return
				}
				slog.Error("attribution v2 pass error", "err", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func writeMetrics(w http.ResponseWriter, m *attribution.Metrics, v2 *attribution.V2Metrics) {
	type row struct {
		name, help string
		val        int64
	}
	rows := []row{
		{"attribution_runs_total", "Attribution passes executed.", m.Runs.Load()},
		{"attribution_examined_total", "Outcomes scored.", m.Examined.Load()},
		{"attribution_attributed_total", "Outcomes matched to a run.", m.Attributed.Load()},
		{"attribution_updated_total", "Outcome rows re-inserted with new attribution.", m.Updated.Load()},
		// Engine v2 (shadow) — deterministic stage (sub-phase 3.1).
		{"attribution_v2_passes_total", "Attribution v2 passes executed.", v2.Passes.Load()},
		{"attribution_v2_examined_total", "Outcomes considered by v2.", v2.Examined.Load()},
		{"attribution_v2_deterministic_total", "Outcomes resolved to a deterministic link.", v2.Deterministic.Load()},
		{"attribution_v2_probabilistic_total", "Outcomes scored to a probabilistic link.", v2.Probabilistic.Load()},
		{"attribution_v2_coalitions_total", "Outcomes resolved to a multi-agent coalition.", v2.Coalitions.Load()},
		{"attribution_v2_edges_written_total", "attribution_edges rows upserted by v2.", v2.EdgesWritten.Load()},
	}
	for _, mt := range rows {
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

func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}
