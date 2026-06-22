package slackalert

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/lib/pq"
)

// PGClient reads budget definitions from Postgres. The alerter needs every
// tenant's budgets, so it connects with a BYPASSRLS role (the same convention as
// the gateway's config reads) — RLS is not bound per request here.
type PGClient struct {
	db *sql.DB
}

// NewPGClient opens a lazy connection pool against dsn.
func NewPGClient(dsn string) (*PGClient, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(5 * time.Minute)
	return &PGClient{db: db}, nil
}

// Budgets returns all budget definitions (cross-tenant).
func (p *PGClient) Budgets(ctx context.Context) ([]Budget, error) {
	const q = `
		SELECT budget_id::text, tenant_id::text, scope_type, scope_id, period,
		       amount_usd::float8, alert_pcts, hard_limit
		FROM budgets`
	rows, err := p.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var out []Budget
	for rows.Next() {
		var b Budget
		var pcts pq.Int64Array
		if err := rows.Scan(&b.BudgetID, &b.TenantID, &b.ScopeType, &b.ScopeID, &b.Period,
			&b.AmountUSD, &pcts, &b.HardLimit); err != nil {
			return nil, err
		}
		b.AlertPcts = make([]int, len(pcts))
		for i, v := range pcts {
			b.AlertPcts[i] = int(v)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// Ping reports Postgres reachability for readiness checks.
func (p *PGClient) Ping(ctx context.Context) error { return p.db.PingContext(ctx) }

// Close releases the connection pool.
func (p *PGClient) Close() error { return p.db.Close() }
