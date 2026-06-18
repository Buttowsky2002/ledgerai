package connector

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// --- outcome test doubles (memStore/fastOpts are shared from sync_test.go) ---

type fakeOutcomeConnector struct {
	kind  string
	pages []OutcomePage
}

func (f *fakeOutcomeConnector) Kind() string { return f.kind }

func (f *fakeOutcomeConnector) Fetch(_ context.Context, _ map[string]any, cur Cursor) (OutcomePage, error) {
	off := 0
	if v, ok := cur.Value["offset"]; ok {
		off = int(v.(float64))
	}
	if off >= len(f.pages) {
		return OutcomePage{Next: cur, Done: true}, nil
	}
	return f.pages[off], nil
}

func outcomePageAt(off, recs int, done bool) OutcomePage {
	rs := make([]OutcomeRecord, recs)
	for i := range rs {
		rs[i] = OutcomeRecord{OutcomeID: "o", OutcomeType: "pr_merged", TS: "2026-06-15 00:00:00.000"}
	}
	return OutcomePage{Records: rs, Next: Cursor{Value: map[string]any{"offset": float64(off + 1)}}, Done: done}
}

type memOutcomeSink struct {
	mu       sync.Mutex
	written  []OutcomeRecord
	failNext int
}

func (s *memOutcomeSink) WriteOutcomes(_ context.Context, recs []OutcomeRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failNext > 0 {
		s.failNext--
		return errors.New("sink boom")
	}
	s.written = append(s.written, recs...)
	return nil
}
func (s *memOutcomeSink) count() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.written) }

// --- tests ---

func TestOutcomeSyncPagesThenDone(t *testing.T) {
	conn := &fakeOutcomeConnector{kind: "github", pages: []OutcomePage{
		outcomePageAt(0, 3, false),
		outcomePageAt(1, 2, true),
	}}
	store := newMemStore(State{ID: "c1", TenantID: "t1", Kind: "github"})
	sink := &memOutcomeSink{}
	s := NewOutcomeSyncer(store, sink, []OutcomeConnector{conn}, fastOpts())

	if err := s.SyncAll(context.Background()); err != nil {
		t.Fatalf("SyncAll: %v", err)
	}
	if sink.count() != 5 {
		t.Fatalf("want 5 outcomes written, got %d", sink.count())
	}
	if store.status["c1"] != "ok" {
		t.Fatalf("want status ok, got %q", store.status["c1"])
	}
}

func TestOutcomeSyncStampsTenantAndSource(t *testing.T) {
	conn := &fakeOutcomeConnector{kind: "github", pages: []OutcomePage{
		{Records: []OutcomeRecord{{OutcomeID: "o1", OutcomeType: "pr_merged"}}, Next: Cursor{}, Done: true},
	}}
	store := newMemStore(State{ID: "c1", TenantID: "tenant-xyz", Kind: "github"})
	sink := &memOutcomeSink{}
	s := NewOutcomeSyncer(store, sink, []OutcomeConnector{conn}, fastOpts())

	if err := s.SyncAll(context.Background()); err != nil {
		t.Fatalf("SyncAll: %v", err)
	}
	got := sink.written[0]
	if got.TenantID != "tenant-xyz" {
		t.Errorf("tenant not stamped: %q", got.TenantID)
	}
	if got.SourceSystem != "github" {
		t.Errorf("source_system not defaulted to kind: %q", got.SourceSystem)
	}
}

func TestOutcomeSyncSinkFailureMarksError(t *testing.T) {
	conn := &fakeOutcomeConnector{kind: "github", pages: []OutcomePage{outcomePageAt(0, 1, true)}}
	store := newMemStore(State{ID: "c1", TenantID: "t1", Kind: "github"})
	sink := &memOutcomeSink{failNext: 10}
	s := NewOutcomeSyncer(store, sink, []OutcomeConnector{conn}, fastOpts())

	if err := s.SyncAll(context.Background()); err != nil {
		t.Fatalf("SyncAll should not return (errors recorded per-connector): %v", err)
	}
	// Sink failed → nothing written, cursor not advanced to done, status error.
	if sink.count() != 0 {
		t.Fatalf("want 0 written on sink failure, got %d", sink.count())
	}
	if _, advanced := store.cursors["c1"]; advanced {
		t.Fatalf("cursor must not advance when the sink write fails")
	}
	if got := store.status["c1"]; got == "ok" || got == "" {
		t.Fatalf("want error status, got %q", got)
	}
}

func TestOutcomeSyncSkipsUnregisteredKind(t *testing.T) {
	// A cost-connector kind has no outcome connector → skipped, not errored.
	store := newMemStore(State{ID: "c1", TenantID: "t1", Kind: "openai_usage"})
	sink := &memOutcomeSink{}
	s := NewOutcomeSyncer(store, sink, []OutcomeConnector{&fakeOutcomeConnector{kind: "github"}}, fastOpts())
	if err := s.SyncAll(context.Background()); err != nil {
		t.Fatalf("SyncAll: %v", err)
	}
	if sink.count() != 0 || store.status["c1"] != "" {
		t.Fatalf("unregistered kind should be skipped untouched")
	}
}
