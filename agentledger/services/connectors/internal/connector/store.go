package connector

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "github.com/lib/pq" // postgres driver
)

// State is a connector's persisted configuration + sync watermark, loaded from
// the Postgres connectors table (deploy/postgres/001_core.sql).
type State struct {
	ID        string
	TenantID  string
	Kind      string
	Config    map[string]any
	Cursor    Cursor
	Status    string
	LastError string
}

// Store persists connector state. Cursor advances and status transitions are
// the durable record that makes incremental sync crash-safe.
type Store interface {
	ListActive(ctx context.Context) ([]State, error)
	SaveCursor(ctx context.Context, id string, cur Cursor) error
	MarkSuccess(ctx context.Context, id string) error
	MarkError(ctx context.Context, id, msg string) error
}

// PGStore is the Postgres-backed Store.
type PGStore struct{ db *sql.DB }

// NewPGStore opens a small connection pool against dsn.
func NewPGStore(dsn string) (*PGStore, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(5 * time.Minute)
	return &PGStore{db: db}, nil
}

// Close closes the underlying database connection pool.
func (s *PGStore) Close() error { return s.db.Close() }

// ListActive returns every connector not explicitly disabled.
func (s *PGStore) ListActive(ctx context.Context) ([]State, error) {
	const q = `
		SELECT connector_id::text, tenant_id::text, kind,
		       COALESCE(config::text, '{}'),
		       COALESCE(sync_cursor::text, '{}'),
		       COALESCE(status, ''), COALESCE(last_error, '')
		FROM connectors
		WHERE status IS DISTINCT FROM 'disabled'`
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var out []State
	for rows.Next() {
		var st State
		var cfgJSON, curJSON string
		if err := rows.Scan(&st.ID, &st.TenantID, &st.Kind, &cfgJSON, &curJSON, &st.Status, &st.LastError); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(cfgJSON), &st.Config); err != nil {
			return nil, fmt.Errorf("connector %s config: %w", st.ID, err)
		}
		if err := json.Unmarshal([]byte(curJSON), &st.Cursor); err != nil {
			return nil, fmt.Errorf("connector %s cursor: %w", st.ID, err)
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// SaveCursor persists the resume watermark. Called only after the page's records
// are durably written, so a crash resumes from the last fully-processed page.
func (s *PGStore) SaveCursor(ctx context.Context, id string, cur Cursor) error {
	b, err := json.Marshal(cur)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`UPDATE connectors SET sync_cursor = $2::jsonb WHERE connector_id = $1`, id, string(b))
	return err
}

// MarkSuccess records a successful sync run, clearing any previous error.
func (s *PGStore) MarkSuccess(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE connectors SET status='ok', last_sync_at=now(), last_error=NULL WHERE connector_id=$1`, id)
	return err
}

// MarkError records a failed sync run with the given error message.
func (s *PGStore) MarkError(ctx context.Context, id, msg string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE connectors SET status='error', last_error=$2 WHERE connector_id=$1`, id, msg)
	return err
}
