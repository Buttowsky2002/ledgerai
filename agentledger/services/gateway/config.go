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
type VirtualKey struct {
	Key           string   `json:"key"` // "alk_..." issued by control plane
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
}

func LoadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
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
