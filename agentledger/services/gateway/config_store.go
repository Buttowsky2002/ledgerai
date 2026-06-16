package main

import (
	"context"
	"log/slog"
	"time"
)

// ConfigStore loads gateway configuration from an external source.
// Implementations must be safe for concurrent calls.
type ConfigStore interface {
	Load(ctx context.Context) (*Config, error)
	Close() error
}

// StartHotReload launches a background goroutine that polls store every
// interval. On each successful load it atomically swaps the gateway snapshot.
// On failure it logs a warning and retains the last-known-good snapshot.
// The goroutine exits when ctx is cancelled.
func StartHotReload(ctx context.Context, store ConfigStore, interval time.Duration, gw *Gateway) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				reloadOnce(ctx, store, gw)
			}
		}
	}()
}

func reloadOnce(ctx context.Context, store ConfigStore, gw *Gateway) {
	cfg, err := store.Load(ctx)
	if err != nil {
		slog.Warn("config hot-reload skipped; serving last-good config", "err", err)
		return
	}
	// Reload the price book from the same path; fall back to current prices on error.
	pb := gw.current.Load().prices
	if cfg.PriceBookPath != "" {
		if loaded, err := LoadPriceBook(cfg.PriceBookPath); err == nil {
			pb = loaded
		} else {
			slog.Warn("price book reload failed; retaining current prices", "err", err)
		}
	}
	// Store.Load returns keys already hashed (Postgres key_hash convention).
	gw.current.Store(newSnapshotFromHashed(cfg, pb))
	slog.Info("config hot-reloaded",
		"virtual_keys", len(cfg.VirtualKeys),
		"dlp_policies", len(cfg.DLP.Policies))
}
