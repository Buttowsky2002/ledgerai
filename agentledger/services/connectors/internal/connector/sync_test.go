package connector

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// --- test doubles ---

// fakeConnector serves a fixed list of pages and counts fetches per starting
// offset so tests can assert replay behavior.
type fakeConnector struct {
	kind  string
	pages []Page
}

func (f *fakeConnector) Kind() string { return f.kind }

func (f *fakeConnector) Fetch(_ context.Context, _ map[string]any, cur Cursor) (Page, error) {
	off := 0
	if v, ok := cur.Value["offset"]; ok {
		off = int(v.(float64)) // cursors round-trip through JSON in real stores
	}
	if off >= len(f.pages) {
		return Page{Next: cur, Done: true}, nil
	}
	return f.pages[off], nil
}

func pageAt(off int, recs int, done bool) Page {
	rs := make([]Record, recs)
	for i := range rs {
		rs[i] = Record{TenantID: "t1", Day: "2026-06-15", Provider: "openai", Model: "gpt-4o", CostUSD: 1}
	}
	return Page{Records: rs, Next: Cursor{Value: map[string]any{"offset": float64(off + 1)}}, Done: done}
}

type memStore struct {
	mu      sync.Mutex
	states  []State
	cursors map[string]Cursor
	status  map[string]string
}

func newMemStore(states ...State) *memStore {
	return &memStore{states: states, cursors: map[string]Cursor{}, status: map[string]string{}}
}
func (m *memStore) ListActive(context.Context) ([]State, error) { return m.states, nil }
func (m *memStore) SaveCursor(_ context.Context, id string, cur Cursor) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cursors[id] = cur
	return nil
}
func (m *memStore) MarkSuccess(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status[id] = "ok"
	return nil
}
func (m *memStore) MarkError(_ context.Context, id, msg string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status[id] = "error:" + msg
	return nil
}

type memSink struct {
	mu       sync.Mutex
	written  []Record
	failNext int // fail the next N writes
}

func (s *memSink) Write(_ context.Context, recs []Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failNext > 0 {
		s.failNext--
		return errors.New("sink boom")
	}
	s.written = append(s.written, recs...)
	return nil
}
func (s *memSink) count() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.written) }

func fastOpts() Options {
	return Options{Interval: 0, RetryAttempts: 1, RetryBase: 0, RetryMax: 0, MaxPages: 100}
}

// --- tests ---

func TestSyncAllPagesThenDone(t *testing.T) {
	conn := &fakeConnector{kind: "openai_usage", pages: []Page{
		pageAt(0, 3, false),
		pageAt(1, 2, false),
		pageAt(2, 1, true),
	}}
	store := newMemStore(State{ID: "c1", Kind: "openai_usage"})
	sink := &memSink{}
	s := NewSyncer(store, sink, []Connector{conn}, fastOpts())

	if err := s.SyncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sink.count() != 6 {
		t.Fatalf("records written = %d, want 6", sink.count())
	}
	if store.status["c1"] != "ok" {
		t.Fatalf("status = %q, want ok", store.status["c1"])
	}
	// Cursor advanced to the final page's Next.
	if off := store.cursors["c1"].Value["offset"].(float64); off != 3 {
		t.Fatalf("final cursor offset = %v, want 3", off)
	}
}

func TestSyncSkipsUnregisteredKind(t *testing.T) {
	store := newMemStore(State{ID: "c1", Kind: "mystery"})
	sink := &memSink{}
	s := NewSyncer(store, sink, nil, fastOpts())
	if err := s.SyncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sink.count() != 0 || store.status["c1"] != "" {
		t.Fatalf("unregistered connector should be skipped untouched")
	}
}

// A sink failure must NOT advance the cursor — the page is reprocessed on the
// next run (crash-replay), and provider_costs dedup makes that safe.
func TestSyncSinkFailureDoesNotAdvanceCursor(t *testing.T) {
	conn := &fakeConnector{kind: "openai_usage", pages: []Page{
		pageAt(0, 3, false),
		pageAt(1, 2, true),
	}}
	store := newMemStore(State{ID: "c1", Kind: "openai_usage"})
	sink := &memSink{failNext: 1} // first write fails
	s := NewSyncer(store, sink, []Connector{conn}, fastOpts())

	_ = s.SyncAll(context.Background()) // error is recorded, not returned fatally
	if _, ok := store.cursors["c1"]; ok {
		t.Fatal("cursor must not advance when the page write failed")
	}
	if got := store.status["c1"]; got == "" || got[:5] != "error" {
		t.Fatalf("status = %q, want error", got)
	}

	// Replay: sink now healthy → full sync completes, all 5 records land.
	sink.failNext = 0
	if err := s.SyncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sink.count() != 5 {
		t.Fatalf("after replay records = %d, want 5", sink.count())
	}
	if store.status["c1"] != "ok" {
		t.Fatalf("status after replay = %q, want ok", store.status["c1"])
	}
}

// Resuming from a mid-stream cursor must not re-emit earlier pages.
func TestSyncResumesFromPersistedCursor(t *testing.T) {
	conn := &fakeConnector{kind: "openai_usage", pages: []Page{
		pageAt(0, 3, false),
		pageAt(1, 2, true),
	}}
	// Start already past page 0.
	store := newMemStore(State{ID: "c1", Kind: "openai_usage", Cursor: Cursor{Value: map[string]any{"offset": float64(1)}}})
	sink := &memSink{}
	s := NewSyncer(store, sink, []Connector{conn}, fastOpts())

	if err := s.SyncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sink.count() != 2 {
		t.Fatalf("records = %d, want 2 (page 0 must not replay)", sink.count())
	}
}

func TestSyncMaxPagesGuard(t *testing.T) {
	// A connector that never reports Done must be bounded.
	conn := &fakeConnector{kind: "loop", pages: nil}
	conn.pages = []Page{{Records: []Record{{TenantID: "t1"}}, Next: Cursor{Value: map[string]any{"offset": float64(0)}}, Done: false}}
	store := newMemStore(State{ID: "c1", Kind: "loop"})
	sink := &memSink{}
	opt := fastOpts()
	opt.MaxPages = 5
	s := NewSyncer(store, sink, []Connector{conn}, opt)

	_ = s.SyncAll(context.Background())
	if got := store.status["c1"]; got == "" || got[:5] != "error" {
		t.Fatalf("runaway connector should end in error, got %q", got)
	}
}

func TestSyncContextCancel(t *testing.T) {
	conn := &fakeConnector{kind: "openai_usage", pages: []Page{pageAt(0, 1, false), pageAt(1, 1, true)}}
	store := newMemStore(State{ID: "c1", Kind: "openai_usage"})
	s := NewSyncer(store, &memSink{}, []Connector{conn}, Options{Interval: time.Hour, MaxPages: 10})
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediate
	if err := s.SyncAll(ctx); err == nil {
		t.Fatal("expected context cancellation error")
	}
}
