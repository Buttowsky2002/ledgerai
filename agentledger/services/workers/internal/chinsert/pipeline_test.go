package chinsert

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// mockInserter records inserts and can fail per a predicate.
type mockInserter struct {
	mu       sync.Mutex
	inserted map[string][][]byte
	failOn   func(table string, rows [][]byte) error
}

func newMockInserter() *mockInserter {
	return &mockInserter{inserted: map[string][][]byte{}}
}

func (m *mockInserter) Insert(_ context.Context, table string, rows [][]byte) error {
	if m.failOn != nil {
		if err := m.failOn(table, rows); err != nil {
			return err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.inserted[table] = append(m.inserted[table], rows...)
	return nil
}

func (m *mockInserter) count(table string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.inserted[table])
}

// mockDLQ records dead-lettered payloads.
type mockDLQ struct {
	mu      sync.Mutex
	letters []string
}

func (d *mockDLQ) DeadLetter(_ context.Context, raw []byte, _ string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.letters = append(d.letters, string(raw))
	return nil
}
func (d *mockDLQ) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.letters)
}

func newTestPipeline(ins Inserter, dlq DeadLetterer) (*Pipeline, *Metrics) {
	m := &Metrics{}
	return NewPipeline(ins, dlq, m, 1, 0), m
}

func TestProcessRoutesByKind(t *testing.T) {
	ins := newMockInserter()
	dlq := &mockDLQ{}
	p, m := newTestPipeline(ins, dlq)

	msgs := [][]byte{
		[]byte(`{"kind":"llm_call","call_id":"1","tenant_id":"t1"}`),
		[]byte(`{"call_id":"2","tenant_id":"t1"}`), // no kind → llm_call
		[]byte(`{"kind":"agent_run","run_id":"r1","tenant_id":"t1"}`),
		[]byte(`{"kind":"outcome","outcome_id":"o1","tenant_id":"t1"}`),
		[]byte(`{"kind":"tool_call","tenant_id":"t1"}`), // skip
		[]byte(`{"kind":"banana","tenant_id":"t1"}`),    // dlq
		[]byte(`{not valid json`),                       // dlq
	}
	if err := p.Process(context.Background(), msgs); err != nil {
		t.Fatalf("process: %v", err)
	}

	if ins.count(TableLLMCalls) != 2 {
		t.Errorf("llm_calls inserted = %d, want 2", ins.count(TableLLMCalls))
	}
	if ins.count(TableAgentRuns) != 1 || ins.count(TableOutcomes) != 1 {
		t.Errorf("agent_runs=%d outcomes=%d, want 1/1", ins.count(TableAgentRuns), ins.count(TableOutcomes))
	}
	if dlq.count() != 2 {
		t.Errorf("dead-lettered = %d, want 2 (bad json + unknown kind)", dlq.count())
	}
	if m.Skipped.Load() != 1 {
		t.Errorf("skipped = %d, want 1 (tool_call)", m.Skipped.Load())
	}
	if m.Inserted.Load() != 4 {
		t.Errorf("inserted metric = %d, want 4", m.Inserted.Load())
	}
}

func TestProcessTransientFailureReturnsErrorNoDLQ(t *testing.T) {
	ins := newMockInserter()
	ins.failOn = func(_ string, _ [][]byte) error { return errors.New("connection refused") }
	dlq := &mockDLQ{}
	p, _ := newTestPipeline(ins, dlq)

	msgs := [][]byte{
		[]byte(`{"kind":"llm_call","call_id":"1","tenant_id":"t1"}`),
		[]byte(`{"kind":"llm_call","call_id":"2","tenant_id":"t1"}`),
	}
	err := p.Process(context.Background(), msgs)
	if err == nil {
		t.Fatal("expected transient error when all rows fail (ClickHouse down)")
	}
	if dlq.count() != 0 {
		t.Fatalf("must NOT dead-letter on a full-batch (transient) failure; got %d", dlq.count())
	}
}

func TestProcessIsolatesPoisonRow(t *testing.T) {
	poison := `{"kind":"llm_call","call_id":"bad","tenant_id":"t1"}`
	ins := newMockInserter()
	// The batch insert fails whenever it contains the poison row; single good
	// rows succeed; the single poison row fails.
	ins.failOn = func(_ string, rows [][]byte) error {
		for _, r := range rows {
			if string(r) == poison {
				return errors.New("row rejected: bad value")
			}
		}
		return nil
	}
	dlq := &mockDLQ{}
	p, m := newTestPipeline(ins, dlq)

	good := `{"kind":"llm_call","call_id":"ok","tenant_id":"t1"}`
	msgs := [][]byte{[]byte(good), []byte(poison)}
	if err := p.Process(context.Background(), msgs); err != nil {
		t.Fatalf("process should succeed after isolating poison: %v", err)
	}
	if ins.count(TableLLMCalls) != 1 || string(ins.inserted[TableLLMCalls][0]) != good {
		t.Fatalf("good row should be inserted; inserted=%v", ins.inserted[TableLLMCalls])
	}
	if dlq.count() != 1 || dlq.letters[0] != poison {
		t.Fatalf("poison row should be dead-lettered; dlq=%v", dlq.letters)
	}
	if m.DeadLettered.Load() != 1 {
		t.Errorf("deadlettered metric = %d, want 1", m.DeadLettered.Load())
	}
}

func TestProcessEmpty(t *testing.T) {
	p, _ := newTestPipeline(newMockInserter(), &mockDLQ{})
	if err := p.Process(context.Background(), nil); err != nil {
		t.Fatalf("empty process should be a no-op: %v", err)
	}
}
