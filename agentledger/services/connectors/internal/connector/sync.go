package connector

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// Syncer drives registered connectors: for each active connector it pages
// through Fetch (rate-limited, retried), writes each page to the sink, and
// persists the cursor only AFTER a successful write. That ordering is what makes
// sync crash-safe: a crash mid-page re-fetches/re-writes that page on restart,
// and the provider_costs ReplacingMergeTree collapses the duplicate — at most
// one page is ever reprocessed, never lost.
type Syncer struct {
	store    Store
	sink     Sink
	registry map[string]Connector
	limiter  *RateLimiter
	retrier  *Retrier
	maxPages int // safety bound against a misbehaving connector that never sets Done
}

// Options configures a Syncer.
type Options struct {
	Interval      time.Duration // min spacing between provider calls
	RetryAttempts int
	RetryBase     time.Duration
	RetryMax      time.Duration
	MaxPages      int
}

func NewSyncer(store Store, sink Sink, connectors []Connector, opt Options) *Syncer {
	reg := make(map[string]Connector, len(connectors))
	for _, c := range connectors {
		reg[c.Kind()] = c
	}
	if opt.MaxPages <= 0 {
		opt.MaxPages = 10000
	}
	return &Syncer{
		store:    store,
		sink:     sink,
		registry: reg,
		limiter:  NewRateLimiter(opt.Interval),
		retrier:  NewRetrier(opt.RetryAttempts, opt.RetryBase, opt.RetryMax),
		maxPages: opt.MaxPages,
	}
}

// SyncAll runs one sync pass over every active connector. A failure on one
// connector is recorded and does not abort the others.
func (s *Syncer) SyncAll(ctx context.Context) error {
	states, err := s.store.ListActive(ctx)
	if err != nil {
		return fmt.Errorf("list connectors: %w", err)
	}
	for _, st := range states {
		conn, ok := s.registry[st.Kind]
		if !ok {
			slog.Warn("no connector registered for kind; skipping", "kind", st.Kind, "id", st.ID)
			continue
		}
		if err := s.syncOne(ctx, conn, st); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			slog.Error("connector sync failed", "kind", st.Kind, "id", st.ID, "err", err)
			_ = s.store.MarkError(ctx, st.ID, err.Error())
		}
	}
	return nil
}

func (s *Syncer) syncOne(ctx context.Context, conn Connector, st State) error {
	cur := st.Cursor
	for page := 0; page < s.maxPages; page++ {
		if err := s.limiter.Wait(ctx); err != nil {
			return err
		}

		var pg Page
		err := s.retrier.Do(ctx, func() error {
			var ferr error
			pg, ferr = conn.Fetch(ctx, st.Config, cur)
			return ferr
		})
		if err != nil {
			return fmt.Errorf("fetch: %w", err)
		}

		if len(pg.Records) > 0 {
			if err := s.sink.Write(ctx, pg.Records); err != nil {
				return fmt.Errorf("sink: %w", err)
			}
		}

		// Persist the resume point only after the page is durably written.
		cur = pg.Next
		if err := s.store.SaveCursor(ctx, st.ID, cur); err != nil {
			return fmt.Errorf("save cursor: %w", err)
		}
		if pg.Done {
			slog.Info("connector synced", "kind", st.Kind, "id", st.ID, "pages", page+1)
			return s.store.MarkSuccess(ctx, st.ID)
		}
	}
	return fmt.Errorf("connector %s exceeded max pages (%d) without completing", st.Kind, s.maxPages)
}
