package main

import (
	"context"
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

// mockStore is a ConfigStore that returns a pre-set config or error.
type mockStore struct {
	cfg *Config
	err error
}

func (m *mockStore) Load(_ context.Context) (*Config, error) { return m.cfg, m.err }
func (m *mockStore) Close() error                            { return nil }

func testPB() *PriceBook { return &PriceBook{} }

func testCfgWithKey(key string) *Config {
	return &Config{
		VirtualKeys: []VirtualKey{{Key: key, TenantID: "t1", MonthlyBudget: 10}},
		DLP:         DLPConfig{FailMode: "open"},
	}
}

// TestHotReloadSwapsSnapshot verifies that after a successful reload the
// gateway uses the new config and the old key is no longer valid.
func TestHotReloadSwapsSnapshot(t *testing.T) {
	initialCfg := testCfgWithKey("alk_original")
	gw := newGateway(initialCfg, testPB(),
		NewBudgetStore(initialCfg.VirtualKeys),
		NewEventSink(EventSinkCfg{Type: "file", Path: os.DevNull, FlushMs: 10, BufferSize: 8}))

	// Postgres store returns keys as hashes (Postgres key_hash convention).
	newHash := sha256hex("alk_new")
	newCfg := testCfgWithKey(newHash)
	store := &mockStore{cfg: newCfg}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	StartHotReload(ctx, store, 40*time.Millisecond, gw)

	// Allow at least two ticks.
	time.Sleep(120 * time.Millisecond)

	snap := gw.current.Load()
	if _, ok := snap.keys.Lookup("alk_original"); ok {
		t.Error("old key should be absent after reload")
	}
	if _, ok := snap.keys.Lookup("alk_new"); !ok {
		t.Error("new key should be present after reload")
	}
}

// TestHotReloadRetainsLastGoodOnError verifies that a failed Load leaves the
// existing snapshot intact.
func TestHotReloadRetainsLastGoodOnError(t *testing.T) {
	initialCfg := testCfgWithKey("alk_stable")
	gw := newGateway(initialCfg, testPB(),
		NewBudgetStore(initialCfg.VirtualKeys),
		NewEventSink(EventSinkCfg{Type: "file", Path: os.DevNull, FlushMs: 10, BufferSize: 8}))

	store := &mockStore{err: fmt.Errorf("postgres unavailable")}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	StartHotReload(ctx, store, 40*time.Millisecond, gw)

	time.Sleep(120 * time.Millisecond)

	if _, ok := gw.current.Load().keys.Lookup("alk_stable"); !ok {
		t.Error("original key must remain when reload fails")
	}
}

// TestHotReloadStopsOnContextCancel verifies the goroutine stops loading once
// the context is cancelled: the load count must not grow after cancel.
func TestHotReloadStopsOnContextCancel(t *testing.T) {
	cfg := testCfgWithKey("alk_x")
	gw := newGateway(cfg, testPB(),
		NewBudgetStore(cfg.VirtualKeys),
		NewEventSink(EventSinkCfg{Type: "file", Path: os.DevNull, FlushMs: 10, BufferSize: 8}))

	store := &countingStore{cfg: cfg}

	ctx, cancel := context.WithCancel(context.Background())
	StartHotReload(ctx, store, 30*time.Millisecond, gw)
	time.Sleep(100 * time.Millisecond)
	cancel()
	after := store.loads()
	time.Sleep(100 * time.Millisecond)

	if grew := store.loads() - after; grew != 0 {
		t.Errorf("store was loaded %d more times after cancel; goroutine did not stop", grew)
	}
}

// countingStore is a ConfigStore that counts Load calls (concurrency-safe).
type countingStore struct {
	cfg *Config
	n   int64
}

func (c *countingStore) Load(_ context.Context) (*Config, error) {
	atomic.AddInt64(&c.n, 1)
	return c.cfg, nil
}
func (c *countingStore) Close() error { return nil }
func (c *countingStore) loads() int64 { return atomic.LoadInt64(&c.n) }
