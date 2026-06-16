package chinsert

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"
)

// DeadLetterer routes a poison message off the main path (to events.dlq).
type DeadLetterer interface {
	DeadLetter(ctx context.Context, raw []byte, reason string) error
}

// Pipeline turns a batch of raw event payloads into ClickHouse inserts,
// isolating poison rows to the DLQ while treating whole-batch failures as
// transient (so the consumer retries rather than dropping data).
type Pipeline struct {
	inserter Inserter
	dlq      DeadLetterer
	metrics  *Metrics
	retries  int
	backoff  time.Duration
}

func NewPipeline(inserter Inserter, dlq DeadLetterer, m *Metrics, retries int, backoff time.Duration) *Pipeline {
	if m == nil {
		m = &Metrics{}
	}
	return &Pipeline{inserter: inserter, dlq: dlq, metrics: m, retries: retries, backoff: backoff}
}

// Process routes msgs by kind, batches them per target table, and flushes each
// batch. It returns an error only for transient failures (ClickHouse
// unreachable), signalling the caller to retry the whole batch WITHOUT
// committing offsets. Poison messages are dead-lettered and never error.
func (p *Pipeline) Process(ctx context.Context, msgs [][]byte) error {
	batches := make(map[string][][]byte)
	for _, m := range msgs {
		var probe struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(m, &probe); err != nil {
			p.deadLetter(ctx, m, "invalid json")
			continue
		}
		table, d := route(probe.Kind)
		switch d {
		case routeInsert:
			batches[table] = append(batches[table], m)
		case routeSkip:
			p.metrics.Skipped.Add(1)
		case routeDeadLetter:
			p.deadLetter(ctx, m, fmt.Sprintf("unroutable kind %q", probe.Kind))
		}
	}

	for table, rows := range batches {
		if err := p.flush(ctx, table, rows); err != nil {
			return err // transient — caller retries without committing
		}
	}
	return nil
}

// flush inserts one table's rows. On batch failure it retries, then isolates
// poison rows one-by-one: if every row fails it is treated as a transient
// outage (returns error, no DLQ); otherwise the individually-failing rows are
// dead-lettered and the rest are accepted.
func (p *Pipeline) flush(ctx context.Context, table string, rows [][]byte) error {
	if err := p.insertWithRetry(ctx, table, rows); err == nil {
		p.metrics.Inserted.Add(int64(len(rows)))
		return nil
	}

	var failed [][]byte
	for _, row := range rows {
		if err := p.inserter.Insert(ctx, table, [][]byte{row}); err != nil {
			p.metrics.InsertErrors.Add(1)
			failed = append(failed, row)
			continue
		}
		p.metrics.Inserted.Add(1)
	}

	if len(failed) == len(rows) {
		// Nothing got in — almost certainly ClickHouse is down, not bad data.
		// Return transient so the consumer redelivers (ReplacingMergeTree
		// dedups any rows that did slip through on an earlier attempt).
		return fmt.Errorf("clickhouse insert failing for all %d rows in %s", len(rows), table)
	}
	for _, row := range failed {
		p.deadLetter(ctx, row, "row rejected by clickhouse")
	}
	return nil
}

func (p *Pipeline) insertWithRetry(ctx context.Context, table string, rows [][]byte) error {
	var err error
	for attempt := 0; attempt <= p.retries; attempt++ {
		if err = p.inserter.Insert(ctx, table, rows); err == nil {
			return nil
		}
		p.metrics.InsertErrors.Add(1)
		if attempt < p.retries {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(p.backoff * time.Duration(attempt+1)):
			}
		}
	}
	return err
}

func (p *Pipeline) deadLetter(ctx context.Context, raw []byte, reason string) {
	if err := p.dlq.DeadLetter(ctx, raw, reason); err != nil {
		slog.Error("dead-letter failed", "err", err, "reason", reason)
		return
	}
	p.metrics.DeadLettered.Add(1)
	slog.Warn("event dead-lettered", "reason", reason)
}
