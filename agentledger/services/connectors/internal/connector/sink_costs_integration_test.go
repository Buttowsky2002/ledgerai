package connector

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

// crashOnceCursorStore wraps memStore and fails the FIRST SaveCursor to model a
// crash that strikes after a page is durably written but before its resume
// cursor is persisted — the exact window the Syncer's write-then-save ordering
// is meant to make safe.
type crashOnceCursorStore struct {
	*memStore
	armed bool
}

func (s *crashOnceCursorStore) SaveCursor(ctx context.Context, id string, cur Cursor) error {
	if s.armed {
		s.armed = false
		return errors.New("simulated crash before cursor persisted")
	}
	return s.memStore.SaveCursor(ctx, id, cur)
}

// countingSink forwards to a real Sink and tallies records actually written, so
// the test can prove the replay physically re-sent page 0 (vs. silently
// skipping it) — the duplicate that ReplacingMergeTree must then collapse.
type countingSink struct {
	inner   Sink
	records int
}

func (c *countingSink) Write(ctx context.Context, recs []Record) error {
	if err := c.inner.Write(ctx, recs); err != nil {
		return err
	}
	c.records += len(recs)
	return nil
}

// Integration: drives the real Syncer through the real ClickHouseSink and proves
// the P2 acceptance criterion — "connectors replay from cursor after crash with
// no duplicates (ReplacingMergeTree dedup verified); per-day drift report query
// returns". Gated by AGENTLEDGER_IT_CH; run on the compose network with
// AGENTLEDGER_CLICKHOUSE_URL=http://clickhouse:8123 against applied migrations.
func TestCostSinkCrashReplayIntegration(t *testing.T) {
	if os.Getenv("AGENTLEDGER_IT_CH") == "" {
		t.Skip("set AGENTLEDGER_IT_CH to run the live ClickHouse integration")
	}
	chURL := os.Getenv("AGENTLEDGER_CLICKHOUSE_URL")
	if chURL == "" {
		chURL = "http://localhost:8123"
	}
	// Unique tenant isolates this run's rows from any prior run's leftovers.
	tenant := fmt.Sprintf("it-costs-%d", time.Now().UnixNano())

	// Two pages of DISTINCT billing lines (distinct ORDER BY identity), so a
	// faithful replay re-writes page 0's two rows and dedup must collapse them.
	conn := &fakeConnector{kind: "openai_usage", pages: []Page{
		{
			Records: []Record{
				{Day: "2026-06-15", Provider: "openai", Model: "gpt-4o", VirtualKeyID: "ka", CostUSD: 10},
				{Day: "2026-06-15", Provider: "openai", Model: "gpt-4o", VirtualKeyID: "kb", CostUSD: 20},
			},
			Next: Cursor{Value: map[string]any{"offset": float64(1)}},
		},
		{
			Records: []Record{
				{Day: "2026-06-15", Provider: "openai", Model: "gpt-4o-mini", CostUSD: 5},
			},
			Next: Cursor{Value: map[string]any{"offset": float64(2)}},
			Done: true,
		},
	}}

	store := &crashOnceCursorStore{
		memStore: newMemStore(State{ID: "c1", Kind: "openai_usage", TenantID: tenant}),
		armed:    true,
	}
	sink := &countingSink{inner: NewClickHouseSink(chURL, "agentledger", "", "")}
	s := NewSyncer(store, sink, []Connector{conn}, fastOpts())

	// Run 1: page 0 writes to ClickHouse, then the cursor persist "crashes".
	_ = s.SyncAll(context.Background())
	if got := store.status["c1"]; len(got) < 5 || got[:5] != "error" {
		t.Fatalf("run 1 should record an error after the simulated crash, got %q", got)
	}

	// Run 2: restart resumes from the un-persisted cursor → page 0 is re-fetched
	// and re-written (a physical duplicate), then the sync completes cleanly.
	if err := s.SyncAll(context.Background()); err != nil {
		t.Fatalf("run 2 (replay): %v", err)
	}
	if store.status["c1"] != "ok" {
		t.Fatalf("status after replay = %q, want ok", store.status["c1"])
	}
	if sink.records != 5 {
		t.Fatalf("records written to ClickHouse = %d, want 5 (page 0 twice + page 1 once)", sink.records)
	}

	// Dedup: ReplacingMergeTree collapses the replayed page → 3 distinct rows,
	// and the replay must not double-count cost.
	if got := chQuery(t, chURL, "SELECT count() FROM agentledger.provider_costs FINAL WHERE tenant_id='"+tenant+"'"); got != "3" {
		t.Fatalf("distinct provider_costs rows after replay = %q, want 3 (no duplicates)", got)
	}
	if got := chQuery(t, chURL, "SELECT round(sum(cost_usd), 2) FROM agentledger.provider_costs FINAL WHERE tenant_id='"+tenant+"'"); got != "35" {
		t.Fatalf("provider_costs total after replay = %q, want 35 (replay double-counted)", got)
	}

	// Per-day drift report query returns. With no gateway rows for this tenant,
	// each provider line surfaces as unreconciled drift (one row per key).
	if got := chQuery(t, chURL, "SELECT count() FROM agentledger.v_cost_reconciliation WHERE tenant_id='"+tenant+"'"); got != "3" {
		t.Fatalf("v_cost_reconciliation rows = %q, want 3", got)
	}
}
