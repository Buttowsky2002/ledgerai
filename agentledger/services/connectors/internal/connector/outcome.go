package connector

import (
	"context"
	"fmt"
	"log/slog"
)

// OutcomeRecord is one normalized business outcome, destined for the ClickHouse
// outcomes table (deploy/clickhouse/001_events.sql). Outcome connectors
// (GitHub/Jira/Zendesk) translate provider payloads into this shape. run_id and
// attribution_confidence are left zero here — the attribution-matcher worker
// (Phase 4 task 3) correlates outcomes to agent_runs and fills them; ROI
// templates (task 4) compute business_value_usd.
//
// OutcomeID must be STABLE for a given source object (e.g. "github:owner/repo#42")
// so crash/cursor replay re-emits identical rows that the outcomes
// ReplacingMergeTree (ordered by tenant_id, ts, outcome_id) collapses.
type OutcomeRecord struct {
	OutcomeID             string  `json:"outcome_id"`
	TenantID              string  `json:"tenant_id"`
	TS                    string  `json:"ts"` // YYYY-MM-DD HH:MM:SS.000 (UTC)
	SourceSystem          string  `json:"source_system"`
	OutcomeType           string  `json:"outcome_type"`
	TeamID                string  `json:"team_id"`
	UserID                string  `json:"user_id"`
	RunID                 string  `json:"run_id"`
	BusinessValueUSD      float64 `json:"business_value_usd"`
	QualityScore          float64 `json:"quality_score"`
	AttributionConfidence float64 `json:"attribution_confidence"`
	CompletionStatus      string  `json:"completion_status"`
}

// OutcomePage is one batch of outcomes plus the cursor to resume from.
type OutcomePage struct {
	Records []OutcomeRecord
	Next    Cursor
	Done    bool
}

// OutcomeConnector incrementally pulls business outcomes from an external system.
// Like Connector it is stateless across calls — all resume state travels through
// the Cursor — so a sync can crash mid-run and resume from the persisted cursor.
type OutcomeConnector interface {
	Kind() string
	Fetch(ctx context.Context, cfg map[string]any, cur Cursor) (OutcomePage, error)
}

// OutcomeSink persists normalized outcome records.
type OutcomeSink interface {
	WriteOutcomes(ctx context.Context, records []OutcomeRecord) error
}

// OutcomeSyncer drives outcome connectors. It mirrors Syncer's crash-safe loop
// (fetch → write → persist-cursor only after a durable write) but for outcomes,
// reusing the generic Store, RateLimiter, and Retrier. The cost-connector path is
// untouched.
type OutcomeSyncer struct {
	store    Store
	sink     OutcomeSink
	registry map[string]OutcomeConnector
	limiter  *RateLimiter
	retrier  *Retrier
	maxPages int
}

// NewOutcomeSyncer builds an OutcomeSyncer that runs the given outcome
// connectors, persisting state via store and writing outcomes to sink.
func NewOutcomeSyncer(store Store, sink OutcomeSink, connectors []OutcomeConnector, opt Options) *OutcomeSyncer {
	reg := make(map[string]OutcomeConnector, len(connectors))
	for _, c := range connectors {
		reg[c.Kind()] = c
	}
	if opt.MaxPages <= 0 {
		opt.MaxPages = 10000
	}
	return &OutcomeSyncer{
		store:    store,
		sink:     sink,
		registry: reg,
		limiter:  NewRateLimiter(opt.Interval),
		retrier:  NewRetrier(opt.RetryAttempts, opt.RetryBase, opt.RetryMax),
		maxPages: opt.MaxPages,
	}
}

// SyncAll runs one pass over every active connector whose kind has a registered
// outcome connector. Cost-connector kinds (no match here) are skipped, exactly as
// the cost Syncer skips outcome kinds.
func (s *OutcomeSyncer) SyncAll(ctx context.Context) error {
	states, err := s.store.ListActive(ctx)
	if err != nil {
		return fmt.Errorf("list connectors: %w", err)
	}
	for _, st := range states {
		conn, ok := s.registry[st.Kind]
		if !ok {
			continue // not an outcome connector kind; the cost syncer handles it
		}
		if err := s.syncOne(ctx, conn, st); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			slog.Error("outcome connector sync failed", "kind", st.Kind, "id", st.ID, "err", err)
			_ = s.store.MarkError(ctx, st.ID, err.Error())
		}
	}
	return nil
}

func (s *OutcomeSyncer) syncOne(ctx context.Context, conn OutcomeConnector, st State) error {
	cur := st.Cursor
	for page := 0; page < s.maxPages; page++ {
		if err := s.limiter.Wait(ctx); err != nil {
			return err
		}

		var pg OutcomePage
		err := s.retrier.Do(ctx, func() error {
			var ferr error
			pg, ferr = conn.Fetch(ctx, st.Config, cur)
			return ferr
		})
		if err != nil {
			return fmt.Errorf("fetch: %w", err)
		}

		if len(pg.Records) > 0 {
			// Framework-owned attribution: stamp the tenant from connector state
			// and default the source_system to the connector kind.
			for i := range pg.Records {
				pg.Records[i].TenantID = st.TenantID
				if pg.Records[i].SourceSystem == "" {
					pg.Records[i].SourceSystem = conn.Kind()
				}
			}
			if err := s.sink.WriteOutcomes(ctx, pg.Records); err != nil {
				return fmt.Errorf("sink: %w", err)
			}
		}

		// Persist the resume point only after the page is durably written.
		cur = pg.Next
		if err := s.store.SaveCursor(ctx, st.ID, cur); err != nil {
			return fmt.Errorf("save cursor: %w", err)
		}
		if pg.Done {
			slog.Info("outcome connector synced", "kind", st.Kind, "id", st.ID, "pages", page+1)
			return s.store.MarkSuccess(ctx, st.ID)
		}
	}
	return fmt.Errorf("outcome connector %s exceeded max pages (%d)", st.Kind, s.maxPages)
}
