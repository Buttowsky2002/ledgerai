package main

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/iotest"
)

// fakeRW is a minimal http.ResponseWriter (+ Flusher) whose Write can be made to
// fail, so client-write failures during streaming are exercisable.
type fakeRW struct {
	hdr      http.Header
	buf      bytes.Buffer
	writeErr error
	flushes  int
}

func (f *fakeRW) Header() http.Header {
	if f.hdr == nil {
		f.hdr = http.Header{}
	}
	return f.hdr
}
func (f *fakeRW) WriteHeader(int) {}
func (f *fakeRW) Write(p []byte) (int, error) {
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	return f.buf.Write(p)
}
func (f *fakeRW) Flush() { f.flushes++ }

func TestStreamPassthroughNormal(t *testing.T) {
	sse := `data: {"model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}` + "\n" +
		`data: {"model":"gpt-4o","usage":{"prompt_tokens":10,"completion_tokens":5}}` + "\n" +
		"data: [DONE]\n"
	w := &fakeRW{}
	var u Usage

	model, err := streamPassthrough(w, strings.NewReader(sse), &u)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if model != "gpt-4o" {
		t.Fatalf("model = %q, want gpt-4o", model)
	}
	if u.InputTokens != 10 || u.OutputTokens != 5 {
		t.Fatalf("usage = %+v, want in=10 out=5", u)
	}
	if !strings.Contains(w.buf.String(), "[DONE]") {
		t.Fatalf("client did not receive the full stream:\n%s", w.buf.String())
	}
}

func TestStreamPassthroughEOFAfterCompleteStreamIsOK(t *testing.T) {
	// Stream ends at a clean upstream EOF (no [DONE] sentinel) — that is success.
	sse := `data: {"model":"gpt-4o","usage":{"prompt_tokens":3,"completion_tokens":7}}` + "\n"
	w := &fakeRW{}
	var u Usage

	_, err := streamPassthrough(w, strings.NewReader(sse), &u)
	if err != nil {
		t.Fatalf("clean EOF should be nil, got %v", err)
	}
	if u.OutputTokens != 7 {
		t.Fatalf("usage = %+v, want out=7", u)
	}
}

func TestStreamPassthroughUpstreamReadError(t *testing.T) {
	boom := errors.New("upstream boom")
	// One good line, then a non-EOF read error from the upstream body.
	body := io.MultiReader(strings.NewReader(`data: {"model":"gpt-4o"}`+"\n"), iotest.ErrReader(boom))
	w := &fakeRW{}
	var u Usage

	_, err := streamPassthrough(w, body, &u)
	if !errors.Is(err, errUpstreamRead) {
		t.Fatalf("err = %v, want errUpstreamRead", err)
	}
}

func TestStreamPassthroughClientWriteError(t *testing.T) {
	w := &fakeRW{writeErr: errors.New("client connection gone")}
	var u Usage

	_, err := streamPassthrough(w, strings.NewReader(`data: {"model":"gpt-4o"}`+"\n"), &u)
	if !errors.Is(err, errClientWrite) {
		t.Fatalf("err = %v, want errClientWrite", err)
	}
}

func TestStreamPassthroughLargeLineNoScannerLimit(t *testing.T) {
	big := strings.Repeat("x", 5<<20) // 5 MiB — well past the old 4 MiB scanner cap
	sse := `data: {"model":"gpt-4o","choices":[{"delta":{"content":"` + big + `"}}]}` + "\n" +
		`data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}` + "\n" +
		"data: [DONE]\n"
	w := &fakeRW{}
	var u Usage

	_, err := streamPassthrough(w, strings.NewReader(sse), &u)
	if err != nil {
		t.Fatalf("a large SSE line must not error, got %v", err)
	}
	if w.buf.Len() < len(big) {
		t.Fatalf("large line was truncated: forwarded %d bytes, want >= %d", w.buf.Len(), len(big))
	}
	if u.OutputTokens != 2 {
		t.Fatalf("usage after large line = %+v, want out=2", u)
	}
}
