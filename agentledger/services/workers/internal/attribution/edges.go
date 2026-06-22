package attribution

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "github.com/lib/pq" // postgres driver (already a workers dependency)
)

// Postgres persistence for the attribution engine v2 (build-plan sub-phase 3.1;
// ADR-040). Edges are the engine's rich, explainable source of truth; the worker
// is the ONLY writer (the API role is read-only). lib/pq is already a workers
// dependency (slack-alerter), so this adds no new dep (CLAUDE.md rule 12).

// Edge is one attribution_edges row (deploy/postgres/010_attribution_engine.sql).
// Nullable columns are pointers so "not computed yet" (counterfactual_delta until
// 3.4) is stored as SQL NULL, distinct from a real 0.
type Edge struct {
	TenantID             string
	OutcomeID            string
	RunID                string
	AgentID              string
	CoalitionID          *string
	Method               string
	ConfidenceRaw        float64
	ConfidenceCalibrated float64
	SignalContributions  []byte // JSON array; the per-signal explanation / evidence refs
	CounterfactualDelta  *float64
	ValueAttributed      *float64 // gross until 3.4 scales it by the incremental share
	CostAttributed       *float64
	ModelVersion         string
}

// ModelVersion is one attribution_model_versions row — the lineage every edge
// references, so any historical score is reproducible (CLAUDE.md rule 10).
type ModelVersion struct {
	Version string
	Kind    string
	Params  []byte // JSON
	Metrics []byte // JSON
	Active  bool
}

// PGStore persists attribution edges, baselines, coalitions, and model lineage.
type PGStore interface {
	EnsureModelVersion(ctx context.Context, mv ModelVersion) error
	UpsertEdges(ctx context.Context, tenantID string, edges []Edge) error
	UpsertBaselines(ctx context.Context, tenantID string, baselines []Baseline) error
	UpsertCoalitions(ctx context.Context, tenantID string, coalitions []Coalition) error
	Ping(ctx context.Context) error
	Close() error
}

// PG is the lib/pq-backed PGStore. Edges are written per-tenant inside a
// transaction that binds app.tenant_id, so the attribution_edges RLS WITH CHECK
// passes WITHOUT a BYPASSRLS role (ADR-040; honors CLAUDE.md rule 3).
type PG struct{ db *sql.DB }

// NewPG opens a lazy connection pool against dsn.
func NewPG(dsn string) (*PG, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	db.SetMaxOpenConns(3)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(5 * time.Minute)
	return &PG{db: db}, nil
}

// EnsureModelVersion inserts the model lineage row if absent (idempotent), so
// edges can reference it via FK.
func (p *PG) EnsureModelVersion(ctx context.Context, mv ModelVersion) error {
	const q = `
		INSERT INTO attribution_model_versions (version, kind, params, metrics, active, created_by)
		VALUES ($1, $2, $3, $4, $5, 'attribution-worker')
		ON CONFLICT (version) DO NOTHING`
	_, err := p.db.ExecContext(ctx, q, mv.Version, mv.Kind, jsonOr(mv.Params, "{}"), jsonOr(mv.Metrics, "{}"), mv.Active)
	if err != nil {
		return fmt.Errorf("ensure model version %s: %w", mv.Version, err)
	}
	return nil
}

// UpsertEdges writes one tenant's edges, refreshing in place on re-score. All
// rows go in a single transaction bound to the tenant.
func (p *PG) UpsertEdges(ctx context.Context, tenantID string, edges []Edge) error {
	if len(edges) == 0 {
		return nil
	}
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// Bind the tenant for RLS (the GUC app_current_tenant() reads). Local to the tx.
	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("bind tenant: %w", err)
	}

	const q = `
		INSERT INTO attribution_edges
		    (tenant_id, outcome_id, run_id, agent_id, coalition_id, attribution_method,
		     confidence_raw, confidence_calibrated, signal_contributions,
		     counterfactual_delta, value_attributed, cost_attributed, model_version)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (tenant_id, outcome_id, run_id, agent_id, model_version) DO UPDATE SET
		    coalition_id          = EXCLUDED.coalition_id,
		    attribution_method    = EXCLUDED.attribution_method,
		    confidence_raw        = EXCLUDED.confidence_raw,
		    confidence_calibrated = EXCLUDED.confidence_calibrated,
		    signal_contributions  = EXCLUDED.signal_contributions,
		    counterfactual_delta  = EXCLUDED.counterfactual_delta,
		    value_attributed      = EXCLUDED.value_attributed,
		    cost_attributed       = EXCLUDED.cost_attributed,
		    created_at            = now()`
	stmt, err := tx.PrepareContext(ctx, q)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()

	for _, e := range edges {
		if _, err := stmt.ExecContext(ctx,
			e.TenantID, e.OutcomeID, e.RunID, e.AgentID, e.CoalitionID, e.Method,
			e.ConfidenceRaw, e.ConfidenceCalibrated, jsonOr(e.SignalContributions, "[]"),
			e.CounterfactualDelta, e.ValueAttributed, e.CostAttributed, e.ModelVersion,
		); err != nil {
			return fmt.Errorf("upsert edge %s/%s: %w", e.OutcomeID, e.RunID, err)
		}
	}
	return tx.Commit()
}

// UpsertBaselines writes one tenant's counterfactual baselines, refreshing in
// place. Same per-tenant RLS binding as UpsertEdges. confounder_checks is the
// validity-caveat JSON the audit UI surfaces (never silent).
func (p *PG) UpsertBaselines(ctx context.Context, tenantID string, baselines []Baseline) error {
	if len(baselines) == 0 {
		return nil
	}
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("bind tenant: %w", err)
	}
	const q = `
		INSERT INTO attribution_baselines
		    (tenant_id, scope, subject_id, outcome_type, baseline_rate,
		     window_start, window_end, sample_size, confounder_checks, model_version)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (tenant_id, scope, subject_id, outcome_type) DO UPDATE SET
		    baseline_rate     = EXCLUDED.baseline_rate,
		    window_start      = EXCLUDED.window_start,
		    window_end        = EXCLUDED.window_end,
		    sample_size       = EXCLUDED.sample_size,
		    confounder_checks = EXCLUDED.confounder_checks,
		    model_version     = EXCLUDED.model_version,
		    computed_at       = now()`
	stmt, err := tx.PrepareContext(ctx, q)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()
	for _, b := range baselines {
		checks, _ := json.Marshal(b.Checks)
		if _, err := stmt.ExecContext(ctx,
			b.TenantID, b.Scope, b.SubjectID, b.OutcomeType, b.BaselineRate(),
			nullStr(b.WindowStart), nullStr(b.WindowEnd), b.TotalCount, checks, ModelVersionCounterfactual,
		); err != nil {
			return fmt.Errorf("upsert baseline %s/%s/%s: %w", b.Scope, b.SubjectID, b.OutcomeType, err)
		}
	}
	return tx.Commit()
}

// UpsertCoalitions writes one tenant's multi-agent coalitions (members + Shapley
// allocation). Must run BEFORE UpsertEdges so the edges' coalition_id FK resolves.
// The coalition_id is deterministic per (tenant, outcome), so re-runs update in place.
func (p *PG) UpsertCoalitions(ctx context.Context, tenantID string, coalitions []Coalition) error {
	if len(coalitions) == 0 {
		return nil
	}
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("bind tenant: %w", err)
	}
	const q = `
		INSERT INTO attribution_coalitions
		    (coalition_id, tenant_id, outcome_id, members, method, sample_count)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (coalition_id) DO UPDATE SET
		    members      = EXCLUDED.members,
		    method       = EXCLUDED.method,
		    sample_count = EXCLUDED.sample_count`
	stmt, err := tx.PrepareContext(ctx, q)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()
	for _, c := range coalitions {
		members, _ := json.Marshal(c.Members)
		if _, err := stmt.ExecContext(ctx, c.CoalitionID, c.TenantID, c.OutcomeID, members, c.Method, c.SampleCount); err != nil {
			return fmt.Errorf("upsert coalition %s: %w", c.OutcomeID, err)
		}
	}
	return tx.Commit()
}

// Ping reports Postgres reachability for readiness checks.
func (p *PG) Ping(ctx context.Context) error { return p.db.PingContext(ctx) }

// Close releases the connection pool.
func (p *PG) Close() error { return p.db.Close() }

// jsonOr returns b as a json string param, defaulting to def when b is empty so a
// jsonb column never receives a NULL/empty where {} or [] is meant.
func jsonOr(b []byte, def string) string {
	if len(b) == 0 {
		return def
	}
	return string(b)
}

// nullStr maps "" → SQL NULL so an empty timestamp string is not coerced into an
// invalid TIMESTAMPTZ.
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
