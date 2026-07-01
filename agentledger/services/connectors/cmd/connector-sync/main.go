// connector-sync — runs the provider-cost connector framework on a schedule.
//
// Each pass loads active connectors from Postgres, pulls provider-billed cost
// incrementally (cursor-based, rate-limited, retried), and writes normalized
// rows to ClickHouse provider_costs for reconciliation against gateway-observed
// cost. Provider importers register themselves in registeredConnectors() as
// they land (Phase 2 tasks 2–4).
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

	dsn := lookupEnv("AGENTLEDGER_PG_DSN")
	if dsn == "" {
		slog.Error("AGENTLEDGER_PG_DSN is required")
		os.Exit(1)
	}
	store, err := connector.NewPGStore(dsn)
	if err != nil {
		slog.Error("postgres store init failed", "err", err)
		os.Exit(1)
	}
	defer func() { _ = store.Close() }()

	sink := connector.NewClickHouseSink(
		env("AGENTLEDGER_CLICKHOUSE_URL", "http://localhost:8123"),
		env("AGENTLEDGER_CLICKHOUSE_DB", "agentledger"),
		env("AGENTLEDGER_CLICKHOUSE_USER", "default"),
		lookupEnv("AGENTLEDGER_CLICKHOUSE_PASSWORD"),
	)

	syncer := connector.NewSyncer(store, sink, registeredConnectors(), connector.Options{
		Interval:      time.Duration(envInt("AGENTLEDGER_CONNECTOR_INTERVAL_MS", 1000)) * time.Millisecond,
		RetryAttempts: envIntLocal("AGENTLEDGER_CONNECTOR_RETRIES", 4),
		RetryBase:     500 * time.Millisecond,
		RetryMax:      30 * time.Second,
	})

	syncEvery := time.Duration(envInt("AGENTLEDGER_SYNC_INTERVAL_SEC", 3600)) * time.Second

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Admin server: liveness + metrics placeholder.
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	srv := &http.Server{Addr: env("AGENTLEDGER_CONNECTOR_ADDR", ":8092"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
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

func runLoop(ctx context.Context, syncer *connector.Syncer, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		slog.Info("connector sync pass starting")
		if err := syncer.SyncAll(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("sync pass error", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// registeredConnectors returns the provider importers compiled into this build.
// Importers are added here as they are implemented (Phase 2 tasks 2–4).
func registeredConnectors() []connector.Connector {
	return []connector.Connector{
		connector.NewOpenAIConnector(),
		connector.NewAnthropicConnector(),
		connector.NewBedrockConnector(),
		connector.NewVertexConnector(),
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
