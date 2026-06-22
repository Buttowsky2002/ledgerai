package attribution

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// Integration: the sub-phase 3.1 acceptance demo. Seeds (a) an SDK-stamped merged
// PR and (b) a Co-Authored-By ticket whose evidence names a concrete run, runs the
// REAL EngineV2 deterministic pass against live ClickHouse + Postgres, then reads
// attribution_edges to prove a deterministic edge is produced end-to-end with the
// PR URL captured as evidence — and that these edges are the training LABELS
// (attribution_method='deterministic'). Precision is 1.0 by construction.
//
// Gated by AGENTLEDGER_IT_PG; run on the compose network with applied migrations,
// AGENTLEDGER_CLICKHOUSE_URL=http://clickhouse:8123 and
// AGENTLEDGER_PG_DSN=postgres://agentledger:dev_only_change_me@postgres:5432/agentledger?sslmode=disable.
func TestEngineV2DeterministicIntegration(t *testing.T) {
	if os.Getenv("AGENTLEDGER_IT_PG") == "" {
		t.Skip("set AGENTLEDGER_IT_PG to run the live Postgres+ClickHouse integration")
	}
	chURL := os.Getenv("AGENTLEDGER_CLICKHOUSE_URL")
	if chURL == "" {
		chURL = "http://localhost:8123"
	}
	dsn := os.Getenv("AGENTLEDGER_PG_DSN")
	if dsn == "" {
		dsn = "postgres://agentledger:dev_only_change_me@localhost:5432/agentledger?sslmode=disable"
	}

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("open pg: %v", err)
	}
	defer func() { _ = db.Close() }()

	// A fresh tenant (UUID) so CH (String) and PG (uuid) agree and the test is
	// self-contained; cleanup cascades to attribution_edges via the FK.
	var tenant string
	if err := db.QueryRow(`INSERT INTO tenants (name) VALUES ('attr-it-3.1') RETURNING tenant_id::text`).Scan(&tenant); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM tenants WHERE tenant_id = $1`, tenant) })

	pr := "github:" + tenant + "/repo#42" // SDK-stamped to run r1
	ticket := "jira:" + tenant + "-9"     // linked by Co-Authored-By evidence to r2

	chInsert(t, chURL, "agent_runs", []map[string]any{
		{"run_id": "r1", "tenant_id": tenant, "agent_id": "A1", "user_id": "u1",
			"started_at": "2026-06-10 09:00:00.000", "ended_at": "2026-06-10 09:05:00.000",
			"status": "completed", "objective": "fix #42", "outcome_id": pr,
			"total_cost_usd": 8, "total_tokens": 1000, "llm_calls": 5, "tool_calls": 2, "risk_events": 0},
		{"run_id": "r2", "tenant_id": tenant, "agent_id": "A2", "user_id": "u2",
			"started_at": "2026-06-10 10:00:00.000", "ended_at": "2026-06-10 10:10:00.000",
			"status": "completed", "objective": "resolve ticket", "outcome_id": "",
			"total_cost_usd": 4, "total_tokens": 500, "llm_calls": 3, "tool_calls": 1, "risk_events": 0},
	})
	chInsert(t, chURL, "outcomes", []map[string]any{
		{"outcome_id": pr, "tenant_id": tenant, "ts": "2026-06-10 09:10:00.000",
			"source_system": "github", "outcome_type": "pr_merged", "team_id": "team1", "user_id": "u1",
			"run_id": "", "business_value_usd": 500, "quality_score": 0.9,
			"attribution_confidence": 0, "completion_status": "merged"},
		{"outcome_id": ticket, "tenant_id": tenant, "ts": "2026-06-10 10:20:00.000",
			"source_system": "jira", "outcome_type": "ticket_resolved", "team_id": "team1", "user_id": "u2",
			"run_id": "", "business_value_usd": 300, "quality_score": 0.7,
			"attribution_confidence": 0, "completion_status": "done"},
	})
	chInsert(t, chURL, "outcome_evidence", []map[string]any{
		{"tenant_id": tenant, "outcome_id": ticket, "evidence_type": "co_authored_by",
			"run_id": "r2", "agent_id": "A2", "evidence_ref": "Co-authored-by: Claude", "ts": "2026-06-10 10:21:00.000"},
	})

	pg, err := NewPG(dsn)
	if err != nil {
		t.Fatalf("new pg store: %v", err)
	}
	defer func() { _ = pg.Close() }()

	eng := NewEngineV2(NewHTTPClient(chURL, "agentledger", "", ""), pg, 240*time.Minute, 35, nil)
	eng.now = func() time.Time { return time.Date(2026, 6, 12, 0, 0, 0, 0, time.UTC) }
	if err := eng.Process(context.Background()); err != nil {
		t.Fatalf("engine v2 process: %v", err)
	}

	// (a) The SDK-stamped PR → a deterministic edge to r1/A1, confidence 1.0, with
	// the PR URL captured as evidence; this row IS a training label.
	var method, runID, agentID, modelVersion, contributions string
	var conf, cost float64
	row := db.QueryRow(`SELECT attribution_method, confidence_calibrated, run_id, agent_id,
	       model_version, signal_contributions::text, coalesce(cost_attributed,0)
	     FROM attribution_edges WHERE tenant_id = $1 AND outcome_id = $2`, tenant, pr)
	if err := row.Scan(&method, &conf, &runID, &agentID, &modelVersion, &contributions, &cost); err != nil {
		t.Fatalf("read PR edge: %v", err)
	}
	if method != "deterministic" || conf != 1.0 || runID != "r1" || agentID != "A1" ||
		modelVersion != ModelVersionDeterministic || cost != 8 {
		t.Fatalf("PR edge = method %s conf %v run %s agent %s model %s cost %v; want deterministic/1.0/r1/A1/%s/8",
			method, conf, runID, agentID, modelVersion, cost, ModelVersionDeterministic)
	}
	if !strings.Contains(contributions, "https://github.com/"+tenant+"/repo/pull/42") {
		t.Fatalf("PR edge evidence = %s, want the PR URL", contributions)
	}
	var sc []signalContribution
	if err := json.Unmarshal([]byte(contributions), &sc); err != nil || len(sc) == 0 {
		t.Fatalf("signal_contributions not valid JSON array: %v / %s", err, contributions)
	}

	// (b) The Co-Authored-By ticket → a deterministic edge to r2/A2 at 0.97.
	var tConf float64
	var tRun string
	if err := db.QueryRow(`SELECT confidence_calibrated, run_id FROM attribution_edges
	     WHERE tenant_id = $1 AND outcome_id = $2`, tenant, ticket).Scan(&tConf, &tRun); err != nil {
		t.Fatalf("read ticket edge: %v", err)
	}
	if tConf != ConfHardEvidence || tRun != "r2" {
		t.Fatalf("ticket edge = conf %v run %s, want 0.97/r2", tConf, tRun)
	}

	// Exactly two deterministic edges (the labels) for the tenant — precision 1.0.
	var labels int
	if err := db.QueryRow(`SELECT count(*) FROM attribution_edges
	     WHERE tenant_id = $1 AND attribution_method = 'deterministic'`, tenant).Scan(&labels); err != nil {
		t.Fatalf("count labels: %v", err)
	}
	if labels != 2 {
		t.Fatalf("deterministic labels = %d, want 2", labels)
	}

	// The decision log got both events (analytics path), tagged engine_version=v2.
	if got := chRow(t, chURL, "SELECT count() FROM agentledger.attribution_events WHERE tenant_id='"+tenant+
		"' AND engine_version='v2' AND attribution_method='deterministic' FORMAT TabSeparated"); got != "2" {
		t.Fatalf("attribution_events v2 rows = %q, want 2", got)
	}
}
