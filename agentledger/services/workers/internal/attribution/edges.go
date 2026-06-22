package attribution

import (
	"context"
	"database/sql"
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

// PGStore persists attribution edges and model lineage to Postgres.
type PGStore interface {
	EnsureModelVersion(ctx context.Context, mv ModelVersion) error
	UpsertEdges(ctx context.Context, tenantID string, edges []Edge) error
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
