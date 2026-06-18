package connector

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClickHouseOutcomeSinkWrite(t *testing.T) {
	var gotQuery, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("query")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	sink := NewClickHouseOutcomeSink(srv.URL, "agentledger", "", "")
	err := sink.WriteOutcomes(context.Background(), []OutcomeRecord{
		{OutcomeID: "github:acme/web#42", TenantID: "t1", TS: "2026-06-10 12:00:00.000", SourceSystem: "github", OutcomeType: "pr_merged", UserID: "alice"},
	})
	if err != nil {
		t.Fatalf("WriteOutcomes: %v", err)
	}
	if !strings.Contains(gotQuery, "INSERT INTO agentledger.outcomes FORMAT JSONEachRow") {
		t.Errorf("query = %q", gotQuery)
	}
	for _, want := range []string{`"outcome_id":"github:acme/web#42"`, `"tenant_id":"t1"`, `"outcome_type":"pr_merged"`} {
		if !strings.Contains(gotBody, want) {
			t.Errorf("body missing %s; got %s", want, gotBody)
		}
	}
	// completion_status defaults to "completed" when unset.
	if !strings.Contains(gotBody, `"completion_status":"completed"`) {
		t.Errorf("completion_status default missing; got %s", gotBody)
	}
}

func TestClickHouseOutcomeSinkEmptyNoop(t *testing.T) {
	sink := NewClickHouseOutcomeSink("http://invalid.invalid", "agentledger", "", "")
	if err := sink.WriteOutcomes(context.Background(), nil); err != nil {
		t.Fatalf("empty write should be a no-op, got %v", err)
	}
}
