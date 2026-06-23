package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A full buffer drops the event and increments the dropped counter (loss is
// measurable). Built without the background loop so nothing drains the channel.
func TestEventSinkFullBufferDrops(t *testing.T) {
	s := &EventSink{ch: make(chan LLMCallEvent, 1)} // observe-only, no drain goroutine

	if !s.Emit(LLMCallEvent{CallID: "a"}) {
		t.Fatal("first emit should be accepted")
	}
	if s.Emit(LLMCallEvent{CallID: "b"}) {
		t.Fatal("second emit should be dropped (buffer full)")
	}
	if got := s.dropped.Load(); got != 1 {
		t.Fatalf("dropped = %d, want 1", got)
	}
	if got := s.emitted.Load(); got != 1 {
		t.Fatalf("emitted = %d, want 1", got)
	}
}

// A non-2xx response is a rejection — counted as rejected, not as a flush error,
// and never treated as success. Also exercises the disk spool of failed batches.
func TestEventSinkHTTP500Rejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	spoolDir := t.TempDir()
	s := NewEventSink(EventSinkCfg{
		Type: "http", URL: srv.URL, FlushMs: 10_000, BufferSize: 8,
		TimeoutMs: 2000, Retries: 0, SpoolDir: spoolDir,
	})
	s.Emit(LLMCallEvent{CallID: "rej"})
	s.Close() // drains → flush → HTTP 500

	if got := s.flushRejected.Load(); got != 1 {
		t.Fatalf("flush_rejected = %d, want 1", got)
	}
	if got := s.flushErrors.Load(); got != 0 {
		t.Fatalf("flush_errors = %d, want 0 (non-2xx is a rejection, not a transport error)", got)
	}

	// The failed batch was spooled to disk as a 0600 ndjson file (content-free).
	entries, _ := os.ReadDir(spoolDir)
	if len(entries) != 1 {
		t.Fatalf("expected exactly one spool file, got %d", len(entries))
	}
	spoolPath := filepath.Join(spoolDir, entries[0].Name())
	info, err := os.Stat(spoolPath)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("spool file perm = %o, want 600", perm)
	}
	data, _ := os.ReadFile(spoolPath)
	if !strings.Contains(string(data), `"rej"`) {
		t.Fatalf("spool file should contain the spooled event: %s", data)
	}
}

// A flush that times out increments the flush-error counter (not rejected).
func TestEventSinkHTTPTimeoutFlushError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(300 * time.Millisecond) // longer than the client timeout below
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	s := NewEventSink(EventSinkCfg{
		Type: "http", URL: srv.URL, FlushMs: 10_000, BufferSize: 8,
		TimeoutMs: 50, Retries: 0,
	})
	s.Emit(LLMCallEvent{CallID: "slow"})
	s.Close()

	if got := s.flushErrors.Load(); got != 1 {
		t.Fatalf("flush_errors = %d, want 1", got)
	}
	if got := s.flushRejected.Load(); got != 0 {
		t.Fatalf("flush_rejected = %d, want 0", got)
	}
}

// The file sink is created with 0600 permissions.
func TestEventSinkFilePerms0600(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.ndjson")
	s := NewEventSink(EventSinkCfg{Type: "file", Path: path, FlushMs: 10_000, BufferSize: 8})
	defer s.Close()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("file sink perm = %o, want 600", perm)
	}
}

// Close drains all buffered events before returning.
func TestEventSinkCloseDrainsQueue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.ndjson")
	// Large flush interval so only the Close-time drain writes the file.
	s := NewEventSink(EventSinkCfg{Type: "file", Path: path, FlushMs: 60_000, BufferSize: 64})

	const n = 5
	for i := 0; i < n; i++ {
		s.Emit(LLMCallEvent{CallID: "drain"})
	}
	s.Close()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := 0
	for _, ln := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if strings.TrimSpace(ln) != "" {
			lines++
		}
	}
	if lines != n {
		t.Fatalf("drained %d events, want %d:\n%s", lines, n, data)
	}
	if got := s.emitted.Load(); got != n {
		t.Fatalf("emitted = %d, want %d", got, n)
	}
}
