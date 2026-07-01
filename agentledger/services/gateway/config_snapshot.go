package main

// gatewaySnapshot is an immutable bundle of all hot-reloadable gateway config.
// Gateway stores one via atomic.Pointer; the hot-reload goroutine atomically
// replaces it so in-flight requests always see a consistent view.
type gatewaySnapshot struct {
	cfg       *Config
	keys      *KeyStore
	dlp       *DLPEngine
	injection *InjectionEngine
	tools     *ToolGovernor
	prices    *PriceBook
}

// newSnapshotFromCfg builds a snapshot from file-based Config where
// VirtualKey.KeyPlaintext holds the bearer token (hashed + cleared on load).
func newSnapshotFromCfg(cfg *Config, pb *PriceBook) *gatewaySnapshot {
	return &gatewaySnapshot{
		cfg:       cfg,
		keys:      NewKeyStore(cfg.VirtualKeys),
		dlp:       NewDLPEngine(cfg.DLP),
		injection: NewInjectionEngine(cfg.Injection),
		tools:     NewToolGovernor(cfg.AgentToolAllow),
		prices:    pb,
	}
}

// newSnapshotFromHashed builds a snapshot where VirtualKey.KeyHash already holds
// the SHA-256 hex hash of the bearer token (Postgres virtual_keys.key_hash).
func newSnapshotFromHashed(cfg *Config, pb *PriceBook) *gatewaySnapshot {
	return &gatewaySnapshot{
		cfg:       cfg,
		keys:      NewKeyStoreFromHashed(cfg.VirtualKeys),
		dlp:       NewDLPEngine(cfg.DLP),
		injection: NewInjectionEngine(cfg.Injection),
		tools:     NewToolGovernor(cfg.AgentToolAllow),
		prices:    pb,
	}
}
