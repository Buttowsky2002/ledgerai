// outcome-sync — runs the outcome-connector framework on a schedule.
//
// Each pass loads active connectors from Postgres, pulls business outcomes
// incrementally (cursor-based, rate-limited, retried), and writes normalized rows
// to the ClickHouse outcomes table for ROI / unit-economics. Outcome importers
// register in registeredOutcomeConnectors(). Cost connectors (other kinds) are
// handled by the separate connector-sync binary and are skipped here.
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

	"github.com/agentledger/connectors/internal/connector"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	dsn := os.Getenv("AGENTLEDGER_PG_DSN")
	if dsn == "" {
		slog.Error("AGENTLEDGER_PG_DSN is required")
		os.Exit(1)
	}
	store, err := connector.NewPGStore(dsn)
	if err != nil {
		slog.Error("postgres store init failed", "err", err)
		os.Exit(1)
	}
	defer store.Close()

	sink := connector.NewClickHouseOutcomeSink(
		env("AGENTLEDGER_CLICKHOUSE_URL", "http://localhost:8123"),
		env("AGENTLEDGER_CLICKHOUSE_DB", "agentledger"),
		env("AGENTLEDGER_CLICKHOUSE_USER", "default"),
		os.Getenv("AGENTLEDGER_CLICKHOUSE_PASSWORD"),
	)

	syncer := connector.NewOutcomeSyncer(store, sink, registeredOutcomeConnectors(), connector.Options{
		Interval:      time.Duration(envInt("AGENTLEDGER_CONNECTOR_INTERVAL_MS", 1000)) * time.Millisecond,
		RetryAttempts: int(envInt("AGENTLEDGER_CONNECTOR_RETRIES", 4)),
		RetryBase:     500 * time.Millisecond,
		RetryMax:      30 * time.Second,
	})

	syncEvery := time.Duration(envInt("AGENTLEDGER_OUTCOME_SYNC_INTERVAL_SEC", 3600)) * time.Second

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	srv := &http.Server{Addr: env("AGENTLEDGER_OUTCOME_ADDR", ":8095"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("admin server error", "err", err)
		}
	}()

	go runLoop(ctx, syncer, syncEvery)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down")
	cancel()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}

func runLoop(ctx context.Context, syncer *connector.OutcomeSyncer, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		slog.Info("outcome sync pass starting")
		if err := syncer.SyncAll(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("outcome sync pass error", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// registeredOutcomeConnectors returns the outcome importers compiled into this
// build. Jira/Zendesk are added here as they land (Phase 4 task 2).
func registeredOutcomeConnectors() []connector.OutcomeConnector {
	return []connector.OutcomeConnector{
		connector.NewGitHubConnector(),
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
