// pricesync — proposes updates to pricing/pricebook.json from the upstream LiteLLM
// list-price feed. The live price book is immutable at runtime (ro mount / ConfigMap);
// this worker writes only pricing/pricebook.candidate.json and pricing/pricebook.diff.json
// for human PR review. Promotion path: review the diff, then
//   mv pricing/pricebook.candidate.json pricing/pricebook.json && git commit && open PR
// CI gates the change; redeploy rebuilds the ConfigMap. Never writes /etc/agentledger/pricing.
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

	"github.com/agentledger/workers/internal/pricesync"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	timeout := time.Duration(envInt("AGENTLEDGER_PRICESYNC_HTTP_TIMEOUT_SEC", 15)) * time.Second
	metrics := &pricesync.Metrics{}
	fetcher := pricesync.NewFetcher(
		env("AGENTLEDGER_PRICESYNC_FEED_URL", ""),
		timeout,
		metrics,
	)
	syncer := pricesync.NewSyncer(
		fetcher,
		env("AGENTLEDGER_PRICESYNC_LIVE", "pricing/pricebook.json"),
		env("AGENTLEDGER_PRICESYNC_OUT", "pricing/pricebook.candidate.json"),
		env("AGENTLEDGER_PRICESYNC_DIFF", "pricing/pricebook.diff.json"),
		envFloat("AGENTLEDGER_PRICESYNC_ALERT_PCT", 0.0),
		metrics,
	)

	interval := time.Duration(envInt("AGENTLEDGER_PRICESYNC_INTERVAL_SEC", 86400)) * time.Second
	oneshot := envBool("AGENTLEDGER_PRICESYNC_ONESHOT", false)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if _, err := os.Stat(syncer.LivePath()); err != nil {
			http.Error(w, `{"status":"live price book unreadable"}`, http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		writeMetrics(w, metrics)
	})
	srv := &http.Server{Addr: env("AGENTLEDGER_WORKER_ADDR", ":8094"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("admin server error", "err", err)
		}
	}()

	if oneshot {
		slog.Info("pricesync oneshot starting")
		if err := syncer.Run(ctx); err != nil {
			slog.Error("pricesync oneshot error", "err", err)
			os.Exit(1)
		}
		return
	}

	go runLoop(ctx, syncer, interval)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down")
	cancel()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}

func runLoop(ctx context.Context, s *pricesync.Syncer, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		slog.Info("pricesync pass starting")
		if err := s.Run(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("pricesync pass error", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func writeMetrics(w http.ResponseWriter, m *pricesync.Metrics) {
	type row struct {
		name, help string
		val        int64
	}
	for _, mt := range []row{
		{"pricesync_runs_total", "Pricesync passes executed.", m.Runs.Load()},
		{"pricesync_changes_total", "Diff rows (new+changed+removed).", m.Changes.Load()},
		{"pricesync_changed_total", "Changed price rows.", m.Changed.Load()},
		{"pricesync_removed_total", "Removed tracked price rows.", m.Removed.Load()},
		{"pricesync_fetch_errors_total", "Upstream feed fetch failures.", m.FetchErrors.Load()},
		{"pricesync_last_run_unixtime", "Unix time of last successful pass start.", m.LastRunUnix.Load()},
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

func envBool(key string, def bool) bool {
	v := lookupEnv(key)
	if v == "" {
		return def
	}
	return v == "true" || v == "1"
}
