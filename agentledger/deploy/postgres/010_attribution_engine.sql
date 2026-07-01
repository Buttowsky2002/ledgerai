-- BadgerIQ Postgres migration 010 — attribution engine (the moat)
--
-- Phase 3 deepening (docs/ATTRIBUTION_ENGINE_BUILD.md): the staged, confidence-
-- scored causal attribution engine. This migration creates its relational source
-- of truth. See ADR-040 for the architecture decision.
--
-- Storage model (ADR-040): the rich, explainable attribution lives here in
-- Postgres (RLS, AGE-projectable, read by the audit UI). The ATTRIBUTION worker
-- ALSO keeps stamping outcomes.attribution_confidence in ClickHouse so the
-- stable §8 contract (v_roi / v_outcome_graph) is untouched — this is the
-- WINNING edge's confidence_calibrated. The worker is the ONLY writer here; the
-- control-plane API (agentledger_api) gets SELECT only (the audit UI reads, never
-- mutates the moat — same posture price_book has in 002_rls).
--
-- Tenant scoping (CLAUDE.md rule 3): edges / baselines / coalitions carry
-- tenant_id with FORCE RLS. signals / model_versions are deployment-global
-- config/lineage (no tenant_id). priors are anonymized cross-tenant aggregates
-- and, by construction (§7 — flywheel anonymity is absolute), have NO tenant_id
-- and can never hold a row-level, single-tenant-derivable value.
--
-- Forward-only; never edit an applied migration.

BEGIN;

-- ============================================================
-- attribution_model_versions — every scorer/calibrator/baseline/priors version,
-- with the metrics it shipped with, so any historical score is reproducible and
-- auditable (CLAUDE.md rule 10). Deployment-global lineage (no tenant_id).
-- ============================================================
CREATE TABLE attribution_model_versions (
    version     TEXT PRIMARY KEY,                    -- e.g. '2026.06.22-scorer-1'
    kind        TEXT NOT NULL,                       -- scorer | calibrator | baseline | priors
    params      JSONB NOT NULL DEFAULT '{}',         -- weights / calibrator knots / decay constants
    metrics     JSONB NOT NULL DEFAULT '{}',         -- ECE, AUC, precision@0.9 at ship time
    active      BOOLEAN NOT NULL DEFAULT false,       -- rolled out behind ATTRIBUTION_ENGINE_V2
    created_by  TEXT NOT NULL DEFAULT 'attribution-priors',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT attribution_model_versions_kind_ck
        CHECK (kind IN ('scorer', 'calibrator', 'baseline', 'priors'))
);
CREATE INDEX attribution_model_versions_kind_idx
    ON attribution_model_versions (kind, active);

-- ============================================================
-- attribution_signals — definitions + current weights for each signal type.
-- Versioned; adding a signal must not require touching the scorer (config-driven,
-- sub-phase 3.2). Deployment-global (no tenant_id).
-- ============================================================
CREATE TABLE attribution_signals (
    signal_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_name TEXT NOT NULL,                       -- e.g. 'temporal_proximity'
    signal_type TEXT NOT NULL,                       -- temporal | identity | artifact | content | behavioral
    weight      DOUBLE PRECISION NOT NULL DEFAULT 0, -- log-odds weight in the scorer
    version     INTEGER NOT NULL DEFAULT 1,          -- bump on every weight change (audited)
    enabled     BOOLEAN NOT NULL DEFAULT true,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT attribution_signals_type_ck
        CHECK (signal_type IN ('temporal', 'identity', 'artifact', 'content', 'behavioral')),
    UNIQUE (signal_name, version)
);

-- ============================================================
-- attribution_priors — flywheel output (§7 — anonymity is absolute). Distributions
-- and constants only, derived from >= min_customer_n tenants. NEVER row-level,
-- identifiable, or single-tenant-derivable. NO tenant_id by construction.
-- ============================================================
CREATE TABLE attribution_priors (
    prior_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prior_type      TEXT NOT NULL,                   -- temporal_decay | baseline_threshold | shapley_distribution | signal_weight
    outcome_type    TEXT NOT NULL DEFAULT '',        -- '' = applies to all outcome types
    segment         TEXT NOT NULL DEFAULT '',        -- e.g. team-size bucket / agent-type; '' = global
    value           JSONB NOT NULL,                  -- the distribution / constant
    min_customer_n  INTEGER NOT NULL,                -- the n it was derived from (the gate)
    model_version   TEXT REFERENCES attribution_model_versions (version),
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT attribution_priors_min_n_ck CHECK (min_customer_n >= 1),
    UNIQUE (prior_type, outcome_type, segment)
);

-- ============================================================
-- attribution_coalitions — multi-agent outcomes (sub-phase 3.5). Ordered member
-- list + Shapley allocation per member. Tenant-scoped.
-- ============================================================
CREATE TABLE attribution_coalitions (
    coalition_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    outcome_id   TEXT NOT NULL,                      -- CH outcome_id, e.g. github:owner/repo#42
    -- members: ordered [{agent_id, run_id, shapley_value, shapley_cost, order}]
    members      JSONB NOT NULL DEFAULT '[]',
    method       TEXT NOT NULL DEFAULT 'exact',      -- exact (<=5) | montecarlo
    sample_count INTEGER NOT NULL DEFAULT 0,         -- MC permutation samples (0 for exact)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT attribution_coalitions_method_ck CHECK (method IN ('exact', 'montecarlo')),
    UNIQUE (tenant_id, outcome_id)
);

-- ============================================================
-- attribution_baselines — counterfactual layer (sub-phase 3.4). Per-identity and
-- per-team outcome rate WITHOUT agent involvement, its window, sample size, and
-- confounder-check results (overlap / placebo / sensitivity). Tenant-scoped.
-- ============================================================
CREATE TABLE attribution_baselines (
    baseline_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    scope             TEXT NOT NULL,                 -- identity | team
    subject_id        TEXT NOT NULL,                 -- identity_id or team_id
    outcome_type      TEXT NOT NULL DEFAULT '',      -- '' = all outcome types
    baseline_rate     DOUBLE PRECISION,              -- outcomes per period without an agent
    window_start      TIMESTAMPTZ,
    window_end        TIMESTAMPTZ,
    sample_size       INTEGER NOT NULL DEFAULT 0,
    -- confounder_checks: {overlap:{...}, placebo:{...}, sensitivity:{...}} — surfaced
    -- as edge caveats, never silent (sub-phase 3.4).
    confounder_checks JSONB NOT NULL DEFAULT '{}',
    model_version     TEXT REFERENCES attribution_model_versions (version),
    computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT attribution_baselines_scope_ck CHECK (scope IN ('identity', 'team')),
    UNIQUE (tenant_id, scope, subject_id, outcome_type)
);

-- ============================================================
-- attribution_edges — the core output, one per outcome→agent (or coalition member)
-- edge. confidence_calibrated is the number everyone reads; signal_contributions
-- is the explanation that makes it auditable (sub-phase 3.3 — non-negotiable).
-- Tenant-scoped. run_id / agent_id use the '' empty-string convention (matching
-- ClickHouse) so the uniqueness key is clean; coalition_id is NULL unless the
-- edge is part of a multi-agent coalition.
-- ============================================================
CREATE TABLE attribution_edges (
    edge_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL REFERENCES tenants ON DELETE CASCADE,
    outcome_id            TEXT NOT NULL,             -- CH outcome_id
    run_id                TEXT NOT NULL DEFAULT '',  -- CH run_id ('' if none)
    agent_id              TEXT NOT NULL DEFAULT '',  -- '' when part of a coalition with no single agent
    coalition_id          UUID REFERENCES attribution_coalitions ON DELETE SET NULL,
    attribution_method    TEXT NOT NULL,             -- deterministic | probabilistic | shapley
    confidence_raw        DOUBLE PRECISION NOT NULL DEFAULT 0,  -- model output, pre-calibration
    confidence_calibrated DOUBLE PRECISION NOT NULL DEFAULT 0,  -- post-calibration; THE number read
    -- signal_contributions: [{signal, weighted_log_odds, value, evidence_ref}] — powers
    -- the audit UI. References only (PR URL, ticket id, timestamps, overlap %), never
    -- copied prompt/completion content (CLAUDE.md rule 2; §7 — evidence not payloads).
    signal_contributions  JSONB NOT NULL DEFAULT '[]',
    counterfactual_delta  DOUBLE PRECISION,          -- incremental fraction above baseline (3.4)
    value_attributed      DOUBLE PRECISION,
    cost_attributed       DOUBLE PRECISION,
    model_version         TEXT NOT NULL REFERENCES attribution_model_versions (version),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT attribution_edges_method_ck
        CHECK (attribution_method IN ('deterministic', 'probabilistic', 'shapley')),
    CONSTRAINT attribution_edges_conf_ck
        CHECK (confidence_calibrated >= 0 AND confidence_calibrated <= 1),
    -- One current edge per (outcome, run, agent) under a given model version; the
    -- worker upserts on this key as it re-scores.
    UNIQUE (tenant_id, outcome_id, run_id, agent_id, model_version)
);
CREATE INDEX attribution_edges_outcome_idx ON attribution_edges (tenant_id, outcome_id);
CREATE INDEX attribution_edges_agent_idx   ON attribution_edges (tenant_id, agent_id);
CREATE INDEX attribution_edges_created_idx ON attribution_edges (tenant_id, created_at);

-- ============================================================
-- Tenant isolation (CLAUDE.md rule 3) — same FORCE-RLS pattern as 002_rls / 007.
-- The worker sets app.tenant_id per tenant batch so WITH CHECK passes without
-- BYPASSRLS; the API reads scoped by its per-request app.tenant_id.
-- ============================================================
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'attribution_edges', 'attribution_coalitions', 'attribution_baselines'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = app_current_tenant()) '
            'WITH CHECK (tenant_id = app_current_tenant())', t);
    END LOOP;
END
$$;

-- ============================================================
-- Least privilege (rule 7) — the API role is READ-ONLY on every attribution
-- table. 002_rls's ALTER DEFAULT PRIVILEGES already granted agentledger_api full
-- CRUD on new tables; revoke the writes so only the worker mutates the moat
-- (same pattern price_book uses in 002_rls). Global tables stay SELECT-only too.
-- ============================================================
REVOKE INSERT, UPDATE, DELETE ON
    attribution_edges, attribution_coalitions, attribution_baselines,
    attribution_signals, attribution_priors, attribution_model_versions
    FROM agentledger_api;
GRANT SELECT ON
    attribution_edges, attribution_coalitions, attribution_baselines,
    attribution_signals, attribution_priors, attribution_model_versions
    TO agentledger_api;

COMMIT;
