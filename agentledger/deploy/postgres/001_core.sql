-- BadgerIQ Postgres schema (control plane / transactional state)
--
-- Postgres owns everything low-volume and consistency-critical:
-- tenants, identities, keys, policies, pricing, allocation rules,
-- connector state, and workflow records. High-volume events live in
-- ClickHouse (deploy/clickhouse/001_events.sql).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Tenancy ----------
CREATE TABLE tenants (
    tenant_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             TEXT NOT NULL,
    region           TEXT NOT NULL DEFAULT 'us',
    plan             TEXT NOT NULL DEFAULT 'trial',     -- trial|team|enterprise
    retention_days   INT  NOT NULL DEFAULT 396,         -- 13 months
    content_capture  TEXT NOT NULL DEFAULT 'metadata_only', -- metadata_only|redacted|full
    compliance_flags JSONB NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Identity graph (users, teams, mapping sources) ----------
CREATE TABLE teams (
    team_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    name       TEXT NOT NULL,
    cost_center TEXT,
    parent_team_id UUID REFERENCES teams,
    UNIQUE (tenant_id, name)
);

CREATE TABLE identities (
    user_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    email        TEXT NOT NULL,
    display_name TEXT,
    team_id      UUID REFERENCES teams,
    manager_id   UUID REFERENCES identities,
    role         TEXT NOT NULL DEFAULT 'member',  -- member|admin|finance|security
    source       TEXT NOT NULL DEFAULT 'manual',  -- manual|scim|okta|entra|hris
    aliases      JSONB NOT NULL DEFAULT '[]',     -- provider account ids, git emails, ...
    UNIQUE (tenant_id, email)
);

-- ---------- Apps & agents (registry) ----------
CREATE TABLE apps (
    app_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    name            TEXT NOT NULL,
    app_type        TEXT NOT NULL DEFAULT 'service', -- service|agent|notebook|saas|dev_tool
    owner_user_id   UUID REFERENCES identities,
    environment     TEXT NOT NULL DEFAULT 'prod',
    approved_status TEXT NOT NULL DEFAULT 'pending', -- approved|pending|denied|shadow
    business_function TEXT,
    UNIQUE (tenant_id, name, environment)
);

CREATE TABLE agents (
    agent_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    app_id            UUID REFERENCES apps,
    name              TEXT NOT NULL,
    runtime_type      TEXT,                       -- sdk|claude_code|cursor|mcp|custom
    owner_user_id     UUID REFERENCES identities,
    data_access_scope JSONB NOT NULL DEFAULT '[]',
    connected_tools   JSONB NOT NULL DEFAULT '[]',
    approval_status   TEXT NOT NULL DEFAULT 'pending',
    risk_posture      TEXT NOT NULL DEFAULT 'unknown',
    decommissioned_at TIMESTAMPTZ
);

-- ---------- Virtual keys (gateway attribution anchor) ----------
CREATE TABLE virtual_keys (
    key_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    key_hash          TEXT NOT NULL UNIQUE,       -- sha256 of alk_ secret; secret shown once
    name              TEXT NOT NULL,
    team_id           UUID REFERENCES teams,
    user_id           UUID REFERENCES identities,
    app_id            UUID REFERENCES apps,
    environment       TEXT NOT NULL DEFAULT 'prod',
    allowed_models    TEXT[] NOT NULL DEFAULT '{}',
    monthly_budget_usd NUMERIC(12,4),
    rate_limit_rpm    INT,
    dlp_policy_id     UUID,
    revoked_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Policies (DLP + governance) ----------
CREATE TABLE policies (
    policy_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    name        TEXT NOT NULL,
    scope       JSONB NOT NULL DEFAULT '{}',     -- {teams:[],apps:[],envs:[]}
    kind        TEXT NOT NULL,                   -- dlp|budget|model_allow|approval
    condition   JSONB NOT NULL DEFAULT '{}',     -- {classes:["credentials","pci"]}
    action      TEXT NOT NULL,                   -- allow|log|warn|redact|block|ticket
    severity    TEXT NOT NULL DEFAULT 'medium',
    fail_mode   TEXT NOT NULL DEFAULT 'open',    -- open|closed
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE virtual_keys
    ADD CONSTRAINT fk_vk_dlp_policy FOREIGN KEY (dlp_policy_id) REFERENCES policies;

-- ---------- Price book (versioned, effective-dated, auditable) ----------
CREATE TABLE price_book (
    price_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider        TEXT NOT NULL,
    model_prefix    TEXT NOT NULL,
    token_type      TEXT NOT NULL,               -- input|output|cache_read|cache_write
    usd_per_million NUMERIC(12,6) NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'USD',
    effective_start TIMESTAMPTZ NOT NULL,
    effective_end   TIMESTAMPTZ,
    source          TEXT NOT NULL,               -- provenance URL/doc for audit
    CONSTRAINT no_negative_price CHECK (usd_per_million >= 0)
);
CREATE INDEX idx_price_lookup ON price_book (provider, token_type, model_prefix, effective_start);

-- ---------- Allocation rules (chargeback) ----------
CREATE TABLE allocation_rules (
    rule_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    priority       INT NOT NULL DEFAULT 100,
    matching_logic JSONB NOT NULL,               -- {key_id|app_id|tag|sso_group: ...}
    target_type    TEXT NOT NULL,                -- team|cost_center|project|customer
    target_id      TEXT NOT NULL,
    split_pct      NUMERIC(5,2) NOT NULL DEFAULT 100.00,
    effective_start DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_end  DATE,
    owner_user_id  UUID REFERENCES identities
);

-- ---------- Budgets (hierarchical) ----------
CREATE TABLE budgets (
    budget_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    scope_type  TEXT NOT NULL,                   -- tenant|team|app|agent|key|model
    scope_id    TEXT NOT NULL,
    period      TEXT NOT NULL DEFAULT 'monthly', -- monthly|quarterly
    amount_usd  NUMERIC(14,2) NOT NULL,
    alert_pcts  INT[] NOT NULL DEFAULT '{50,80,100}',
    hard_limit  BOOLEAN NOT NULL DEFAULT false,  -- false = alert-only (showback)
    UNIQUE (tenant_id, scope_type, scope_id, period)
);

-- ---------- Connectors (provider import state) ----------
CREATE TABLE connectors (
    connector_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    kind          TEXT NOT NULL,    -- openai_usage|anthropic_usage|bedrock|vertex|github|jira|zendesk
    config        JSONB NOT NULL DEFAULT '{}',   -- non-secret config; secrets in vault
    secret_ref    TEXT,                          -- reference into KMS/vault
    status        TEXT NOT NULL DEFAULT 'pending',
    last_sync_at  TIMESTAMPTZ,
    last_error    TEXT,
    sync_cursor   JSONB NOT NULL DEFAULT '{}'    -- incremental import watermark
);

-- ---------- ROI definitions ----------
CREATE TABLE roi_templates (
    template_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID REFERENCES tenants ON DELETE CASCADE, -- NULL = built-in pack
    name          TEXT NOT NULL,
    outcome_type  TEXT NOT NULL,                 -- pr_merged|ticket_resolved|...
    source_system TEXT NOT NULL,
    value_formula JSONB NOT NULL,                -- {hourly_rate, baseline_minutes, rework_pct}
    attribution   JSONB NOT NULL DEFAULT '{}'    -- {window_minutes, match_on:[branch,user,issue]}
);

-- ---------- Audit log ----------
CREATE TABLE audit_log (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  UUID NOT NULL,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    object     TEXT NOT NULL,
    detail     JSONB NOT NULL DEFAULT '{}',
    at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant_time ON audit_log (tenant_id, at DESC);

COMMIT;
