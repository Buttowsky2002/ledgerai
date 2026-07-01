// slack-alerter — posts budget-threshold breaches and critical risk events to a
// Slack webhook (Phase 6 F2). It polls Postgres (budgets) + ClickHouse (spend,
// risk_events) on an interval and de-duplicates alerts in memory.
//
//	budgets (PG) + spend (CH) + risk_events (CH) ─▶ [slack-alerter] ─▶ Slack webhook
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

	"github.com/badgeriq/workers/internal/slackalert"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	pg, err := slackalert.NewPGClient(env("BADGERIQ_PG_DSN", "postgres://agentledger:dev_only_change_me@localhost:5432/agentledger?sslmode=disable"))
	if err != nil {
		slog.Error("postgres init failed", "err", err)
		os.Exit(1)
	}
	defer func() { _ = pg.Close() }()

	ch := slackalert.NewCHClient(
		env("BADGERIQ_CLICKHOUSE_URL", "http://localhost:8123"),
		env("BADGERIQ_CLICKHOUSE_DB", "agentledger"),
		env("BADGERIQ_CLICKHOUSE_USER", "default"),
		lookupEnv("BADGERIQ_CLICKHOUSE_PASSWORD"),
	)

	// Webhook URL by env-var NAME only (rule 1); unset → alerting disabled.
	slack := slackalert.NewSlackNotifier(lookupEnv("BADGERIQ_SLACK_WEBHOOK_URL"))
	if !slack.Enabled() {
		slog.Warn("BADGERIQ_SLACK_WEBHOOK_URL unset — alerting disabled (no-op passes)")
	}

	metrics := &slackalert.Metrics{}
	alerter := slackalert.New(pg, ch, slack, metrics, time.Now)
	interval := time.Duration(envInt("BADGERIQ_SLACK_ALERT_INTERVAL_SEC", 300)) * time.Second

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
	srv := &http.Server{Addr: env("BADGERIQ_WORKER_ADDR", ":8101"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("admin server error", "err", err)
		}
	}()

	go runLoop(ctx, alerter, interval)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down")
	cancel()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}

func runLoop(ctx context.Context, a *slackalert.Alerter, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		if err := a.Run(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("alert pass error", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func writeMetrics(w http.ResponseWriter, m *slackalert.Metrics) {
	type row struct {
		name, help string
		val        int64
	}
	for _, mt := range []row{
		{"slack_alert_runs_total", "Alert passes executed.", m.Runs.Load()},
		{"slack_alerts_sent_total", "Alerts posted to Slack.", m.AlertsSent.Load()},
		{"slack_alerts_failed_total", "Slack posts that failed.", m.AlertsFailed.Load()},
		{"slack_budget_breaches_detected_total", "Budget threshold crossings detected.", m.BudgetBreaches.Load()},
		{"slack_risk_events_detected_total", "Critical risk events detected.", m.RiskEvents.Load()},
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
