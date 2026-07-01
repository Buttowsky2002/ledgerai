package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/lib/pq"
)

// PGConfigStore implements ConfigStore against the AgentLedger Postgres schema.
// It reloads virtual_keys, DLP policies, and the per-agent tool/MCP allowlist on
// each Load call; static fields (listen_addr, providers, events, redis) come
// from the base Config.
//
// Keys are returned with VirtualKey.KeyHash = key_hash (the SHA-256 hex stored
// in Postgres); KeyID is derived during key-store construction. Callers build a
// KeyStore via NewKeyStoreFromHashed.
type PGConfigStore struct {
	db   *sql.DB
	base *Config
}

// NewPGConfigStore opens a connection pool against dsn. The connection is lazy
// (sql.Open does not dial); the first Load call establishes the real connection.
func NewPGConfigStore(dsn string, base *Config) (*PGConfigStore, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	db.SetMaxOpenConns(3)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(5 * time.Minute)
	return &PGConfigStore{db: db, base: base}, nil
}

// Load fetches current virtual_keys and DLP policies and returns a merged *Config.
func (s *PGConfigStore) Load(ctx context.Context) (*Config, error) {
	cfg := *s.base // shallow copy; static fields kept from base

	keys, err := s.loadVirtualKeys(ctx)
	if err != nil {
		return nil, fmt.Errorf("virtual_keys: %w", err)
	}
	cfg.VirtualKeys = keys

	policies, err := s.loadDLPPolicies(ctx)
	if err != nil {
		return nil, fmt.Errorf("dlp policies: %w", err)
	}
	cfg.DLP = DLPConfig{
		FailMode: s.base.DLP.FailMode,
		Policies: policies,
	}

	allow, err := s.loadToolAllowlist(ctx)
	if err != nil {
		return nil, fmt.Errorf("tool allowlist: %w", err)
	}
	cfg.AgentToolAllow = allow

	injPolicies, err := s.loadInjectionPolicies(ctx)
	if err != nil {
		return nil, fmt.Errorf("injection policies: %w", err)
	}
	cfg.Injection = s.base.Injection
	if cfg.Injection.BlockMinConfidence <= 0 {
		cfg.Injection.BlockMinConfidence = 0.8
	}
	cfg.Injection.Policies = injPolicies

	return &cfg, nil
}

// Close releases the underlying connection pool.
func (s *PGConfigStore) Close() error { return s.db.Close() }

func (s *PGConfigStore) loadVirtualKeys(ctx context.Context) ([]VirtualKey, error) {
	const q = `
		SELECT
			key_hash,
			tenant_id::text,
			COALESCE(team_id::text, ''),
			COALESCE(user_id::text, ''),
			COALESCE(app_id::text, ''),
			environment,
			COALESCE(allowed_models, '{}'),
			COALESCE(monthly_budget_usd::float8, 0),
			COALESCE(rate_limit_rpm, 0),
			COALESCE(dlp_policy_id::text, ''),
			COALESCE(injection_policy_id, '')
		FROM virtual_keys
		WHERE revoked_at IS NULL`

	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var out []VirtualKey
	for rows.Next() {
		var vk VirtualKey
		var models pq.StringArray
		if err := rows.Scan(
			&vk.KeyHash, &vk.TenantID, &vk.TeamID, &vk.UserID, &vk.AppID,
			&vk.Environment, &models,
			&vk.MonthlyBudget, &vk.RateLimitRPM, &vk.DLPPolicyID, &vk.InjectionPolicyID,
		); err != nil {
			return nil, err
		}
		vk.AllowedModels = []string(models)
		out = append(out, vk)
	}
	return out, rows.Err()
}

// loadToolAllowlist reads the per-agent tool/MCP allowlist that tool governance
// enforces inline (ADR-032). Cross-tenant by design: the gateway serves every
// tenant, so it loads all rows (it connects as a BYPASSRLS role, as it already
// does for virtual_keys and policies).
func (s *PGConfigStore) loadToolAllowlist(ctx context.Context) ([]AgentToolAllowEntry, error) {
	const q = `
		SELECT tenant_id::text, agent_id::text, tool_name, COALESCE(mcp_server, '')
		FROM agent_tool_allowlist`

	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var out []AgentToolAllowEntry
	for rows.Next() {
		var e AgentToolAllowEntry
		if err := rows.Scan(&e.TenantID, &e.AgentID, &e.ToolName, &e.MCPServer); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *PGConfigStore) loadDLPPolicies(ctx context.Context) ([]DLPPolicy, error) {
	const q = `
		SELECT policy_id::text, action, condition::text
		FROM policies
		WHERE kind = 'dlp' AND enabled = true`

	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var out []DLPPolicy
	for rows.Next() {
		var pol DLPPolicy
		var condText string
		if err := rows.Scan(&pol.ID, &pol.Action, &condText); err != nil {
			return nil, err
		}
		var cond struct {
			Classes []string `json:"classes"`
		}
		if err := json.Unmarshal([]byte(condText), &cond); err == nil {
			pol.Classes = cond.Classes
		}
		out = append(out, pol)
	}
	return out, rows.Err()
}

func (s *PGConfigStore) loadInjectionPolicies(ctx context.Context) ([]InjectionPolicy, error) {
	const q = `
		SELECT id, COALESCE(classes, '{}'), action
		FROM injection_policy`

	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var out []InjectionPolicy
	for rows.Next() {
		var pol InjectionPolicy
		var classes pq.StringArray
		if err := rows.Scan(&pol.ID, &classes, &pol.Action); err != nil {
			return nil, err
		}
		pol.Classes = []string(classes)
		out = append(out, pol)
	}
	return out, rows.Err()
}
