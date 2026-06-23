package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Config is the gateway's static configuration. In production this is
// served from the control plane (Postgres) with hot reload; for the MVP
// it is a JSON file so the gateway has zero runtime dependencies.
type Config struct {
	ListenAddr    string        `json:"listen_addr"`
	PriceBookPath string        `json:"price_book_path"`
	Providers     []ProviderCfg `json:"providers"`
	VirtualKeys   []VirtualKey  `json:"virtual_keys"`
	DLP           DLPConfig     `json:"dlp"`
	Events        EventSinkCfg  `json:"events"`
	Redis         RedisCfg      `json:"redis"`
	// AgentToolAllow is the per-agent tool/MCP allowlist enforced inline by tool
	// governance (ADR-032). From Postgres it is loaded from agent_tool_allowlist;
	// in file config it can be set directly. Empty = no agent is governed inline.
	AgentToolAllow []AgentToolAllowEntry `json:"agent_tool_allow,omitempty"`
}

// RedisCfg configures the optional Redis-backed BudgetStore.
// When Addr is empty the gateway falls back to the in-process MemBudgetStore.
type RedisCfg struct {
	// Addr is "host:port". Empty → MemBudgetStore (single-process, ephemeral).
	Addr string `json:"addr"`
	// PasswordEnv is the environment variable name that holds the Redis auth
	// password. Never put the password value here; config files hold env-var
	// names only (per CLAUDE_CODE_BUILD_SPEC §4 rule 1).
	PasswordEnv string `json:"password_env,omitempty"`
	// DB is the Redis database index (0 = default).
	DB int `json:"db,omitempty"`
}

// ProviderCfg routes model prefixes to an upstream OpenAI-compatible API.
type ProviderCfg struct {
	Name          string   `json:"name"`           // "openai", "anthropic", "azure_openai", ...
	BaseURL       string   `json:"base_url"`       // e.g. https://api.openai.com
	APIKeyEnv     string   `json:"api_key_env"`    // env var holding the upstream key
	ModelPrefixes []string `json:"model_prefixes"` // e.g. ["gpt-", "o4"], ["claude-"]
}

// VirtualKey is the attribution anchor: every request maps to a tenant,
// team, user, and app through the key that made it.
//
// The bearer token never lives in memory in plaintext. KeyPlaintext is accepted
// only as file-config *input* (json:"key") and is hashed then cleared by
// normalizeKey before the VirtualKey is stored. KeyHash (SHA-256 hex) is the
// lookup + budget anchor; KeyID is the non-secret public identifier surfaced in
// events and snapshots.
type VirtualKey struct {
	// KeyPlaintext is the "alk_..." token from file config input only. It is
	// hashed into KeyHash and cleared during key-store construction — never
	// retained, emitted, or logged. (Postgres config never sets this.)
	KeyPlaintext string `json:"key,omitempty"`
	// KeyHash is the SHA-256 hex of the bearer token (Postgres virtual_keys.key_hash).
	KeyHash string `json:"key_hash,omitempty"`
	// KeyID is the stable, non-secret public id: provided by the control plane,
	// else derived as "vk_" + KeyHash[:16].
	KeyID         string   `json:"key_id,omitempty"`
	TenantID      string   `json:"tenant_id"`
	TeamID        string   `json:"team_id"`
	UserID        string   `json:"user_id"`
	AppID         string   `json:"app_id"`
	Environment   string   `json:"environment"`    // prod | staging | dev
	AllowedModels []string `json:"allowed_models"` // empty = all
	MonthlyBudget float64  `json:"monthly_budget_usd"`
	RateLimitRPM  int      `json:"rate_limit_rpm"`
	DLPPolicyID   string   `json:"dlp_policy_id"`
}

// DLPConfig holds classifier rules and per-policy actions.
type DLPConfig struct {
	FailMode string      `json:"fail_mode"` // "open" | "closed"
	Policies []DLPPolicy `json:"policies"`
}

// DLPPolicy maps a classifier policy ID to the action taken when its classes match.
type DLPPolicy struct {
	ID      string   `json:"id"`
	Action  string   `json:"action"`  // allow | log | warn | redact | block
	Classes []string `json:"classes"` // which classifier classes this policy covers; empty = all
}

// EventSinkCfg configures async event emission.
type EventSinkCfg struct {
	// Type: "stdout" (dev), "file", or "http" (ClickHouse JSONEachRow insert
	// endpoint or the ingest collector in front of Kafka/Redpanda).
	Type       string `json:"type"`
	Path       string `json:"path,omitempty"`
	URL        string `json:"url,omitempty"`
	FlushMs    int    `json:"flush_ms,omitempty"`
	BufferSize int    `json:"buffer_size,omitempty"`
	// TimeoutMs bounds each HTTP flush request (default 30000).
	TimeoutMs int `json:"timeout_ms,omitempty"`
	// Retries is the number of extra HTTP flush attempts on transport error / 5xx
	// (bounded backoff between attempts). 0 = no retry.
	Retries int `json:"retries,omitempty"`
	// SpoolDir, when set, persists failed flush batches as ndjson (content-free)
	// for later replay. From LEDGERAI_EVENT_SPOOL_DIR.
	SpoolDir string `json:"spool_dir,omitempty"`
	// FailMode: "observe_only" (default — drop on a full buffer, measured) or
	// "strict" (apply bounded backpressure to minimize loss). From
	// LEDGERAI_EVENT_FAIL_MODE.
	FailMode string `json:"fail_mode,omitempty"`
}

// LoadConfig reads and parses the gateway configuration from a JSON file.
func LoadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path) // #nosec G304 -- path is an operator-provided config file path set at startup, not user input
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if c.ListenAddr == "" {
		c.ListenAddr = ":8080"
	}
	if c.Events.FlushMs == 0 {
		c.Events.FlushMs = 500
	}
	if c.Events.BufferSize == 0 {
		c.Events.BufferSize = 4096
	}
	if c.Events.TimeoutMs == 0 {
		c.Events.TimeoutMs = 30000
	}
	if c.Events.Retries == 0 {
		c.Events.Retries = 2
	}
	// Hash + clear plaintext bearer tokens and derive key ids at load time, so the
	// plaintext never propagates to the budget store, snapshot, events, or logs.
	for i := range c.VirtualKeys {
		normalizeKey(&c.VirtualKeys[i])
	}
	return &c, nil
}

// resolveProvider picks the upstream for a model name by longest prefix match.
func (c *Config) resolveProvider(model string) (*ProviderCfg, bool) {
	var best *ProviderCfg
	bestLen := -1
	for i := range c.Providers {
		for _, p := range c.Providers[i].ModelPrefixes {
			if strings.HasPrefix(model, p) && len(p) > bestLen {
				best = &c.Providers[i]
				bestLen = len(p)
			}
		}
	}
	return best, best != nil
}

func newID(prefix string) string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}
