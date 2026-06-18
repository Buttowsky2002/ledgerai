package attribution

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFetchOutcomesUsesFinalAndBindsParam(t *testing.T) {
	var gotParam, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotParam = r.URL.Query().Get("param_since")
		b, _ := io.ReadAll(r.Body)
		gotQuery = string(b)
		_, _ = io.WriteString(w, `{"outcome_id":"jira:PROJ-1","tenant_id":"t1","ts":"2026-06-17 11:00:00.000","source_system":"jira","outcome_type":"issue_closed","team_id":"","user_id":"acc-1","run_id":"","business_value_usd":0,"quality_score":0,"attribution_confidence":0,"completion_status":"Done"}`+"\n")
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL, "agentledger", "default", "")
	rows, err := c.FetchOutcomes(context.Background(), "2026-05-18 00:00:00.000")
	if err != nil {
		t.Fatal(err)
	}
	if gotParam != "2026-05-18 00:00:00.000" {
		t.Fatalf("param_since = %q", gotParam)
	}
	if !strings.Contains(gotQuery, "FROM agentledger.outcomes FINAL") {
		t.Fatalf("query must read FINAL: %q", gotQuery)
	}
	if !strings.Contains(gotQuery, "{since:DateTime64(3)}") || strings.Contains(gotQuery, "2026-05-18") {
		t.Fatalf("since must be a bound param, not inlined: %q", gotQuery)
	}
	if len(rows) != 1 || rows[0].OutcomeID != "jira:PROJ-1" || rows[0].UserID != "acc-1" {
		t.Fatalf("rows parsed wrong: %+v", rows)
	}
}

func TestFetchRunsFiltersCompletedFinal(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotQuery = string(b)
		_, _ = io.WriteString(w, `{"run_id":"r1","tenant_id":"t1","user_id":"acc-1","ended_at":"2026-06-17 10:50:00.000","status":"completed","objective":"PROJ-1","outcome_id":""}`+"\n")
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL, "agentledger", "default", "")
	rows, err := c.FetchRuns(context.Background(), "2026-05-18 00:00:00.000")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotQuery, "FROM agentledger.agent_runs FINAL") || !strings.Contains(gotQuery, "status = 'completed'") {
		t.Fatalf("runs query wrong: %q", gotQuery)
	}
	if len(rows) != 1 || rows[0].RunID != "r1" {
		t.Fatalf("rows parsed wrong: %+v", rows)
	}
}

func TestWriteOutcomesPostsJSONEachRow(t *testing.T) {
	var gotQuery, gotBody, gotUser string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("query")
		gotUser = r.Header.Get("X-ClickHouse-User")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL, "agentledger", "default", "")
	rows := []OutcomeRow{{OutcomeID: "jira:PROJ-1", TenantID: "t1", TS: "2026-06-17 11:00:00.000", RunID: "run-1", AttributionConfidence: 0.9833}}
	if err := c.WriteOutcomes(context.Background(), rows); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotQuery, "INSERT INTO agentledger.outcomes") || !strings.Contains(gotQuery, "JSONEachRow") {
		t.Fatalf("query = %q", gotQuery)
	}
	if gotUser != "default" {
		t.Fatalf("user header = %q", gotUser)
	}
	var got OutcomeRow
	if err := json.Unmarshal([]byte(strings.TrimSpace(gotBody)), &got); err != nil {
		t.Fatalf("body not JSONEachRow: %q", gotBody)
	}
	if got.RunID != "run-1" || got.AttributionConfidence != 0.9833 {
		t.Fatalf("written row wrong: %+v", got)
	}
}

func TestWriteOutcomesEmptyIsNoop(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer srv.Close()
	c := NewHTTPClient(srv.URL, "agentledger", "", "")
	if err := c.WriteOutcomes(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("empty write must not hit ClickHouse")
	}
}

func TestQueryErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Code: 60. Unknown table", http.StatusBadRequest)
	}))
	defer srv.Close()
	c := NewHTTPClient(srv.URL, "agentledger", "", "")
	if _, err := c.FetchOutcomes(context.Background(), "2026-05-18 00:00:00.000"); err == nil || !strings.Contains(err.Error(), "status 400") {
		t.Fatalf("err = %v, want status 400", err)
	}
}
