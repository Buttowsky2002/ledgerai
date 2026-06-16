package chinsert

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPInserterPostsJSONEachRow(t *testing.T) {
	var gotQuery, gotBody, gotUser string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("query")
		gotUser = r.Header.Get("X-ClickHouse-User")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ins := NewHTTPInserter(srv.URL, "agentledger", "default", "")
	rows := [][]byte{[]byte(`{"call_id":"a"}`), []byte(`{"call_id":"b"}`)}
	if err := ins.Insert(context.Background(), TableLLMCalls, rows); err != nil {
		t.Fatalf("insert: %v", err)
	}

	if !strings.Contains(gotQuery, "INSERT INTO agentledger.llm_calls") ||
		!strings.Contains(gotQuery, "FORMAT JSONEachRow") {
		t.Fatalf("query = %q", gotQuery)
	}
	// NDJSON: one JSON object per line.
	if gotBody != `{"call_id":"a"}`+"\n"+`{"call_id":"b"}`+"\n" {
		t.Fatalf("body = %q", gotBody)
	}
	if gotUser != "default" {
		t.Fatalf("user header = %q", gotUser)
	}
}

func TestHTTPInserterSkipUnknownFieldsSetting(t *testing.T) {
	var skip string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		skip = r.URL.Query().Get("input_format_skip_unknown_fields")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ins := NewHTTPInserter(srv.URL, "agentledger", "", "")
	_ = ins.Insert(context.Background(), TableLLMCalls, [][]byte{[]byte(`{"call_id":"a","kind":"llm_call"}`)})
	if skip != "1" {
		t.Fatalf("skip_unknown_fields = %q, want 1 (must tolerate kind/source keys)", skip)
	}
}

func TestHTTPInserterErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Code: 62. DB::Exception: Syntax error", http.StatusBadRequest)
	}))
	defer srv.Close()

	ins := NewHTTPInserter(srv.URL, "agentledger", "", "")
	err := ins.Insert(context.Background(), TableLLMCalls, [][]byte{[]byte(`{}`)})
	if err == nil {
		t.Fatal("expected error on non-200 status")
	}
	if !strings.Contains(err.Error(), "status 400") {
		t.Fatalf("error = %v", err)
	}
}

func TestHTTPInserterRejectsUnknownTable(t *testing.T) {
	ins := NewHTTPInserter("http://unused", "agentledger", "", "")
	err := ins.Insert(context.Background(), "users; DROP TABLE x", [][]byte{[]byte(`{}`)})
	if err == nil {
		t.Fatal("inserter must refuse a table not on the allowlist")
	}
}
