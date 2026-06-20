package chinsert

import (
	"fmt"
	"io"
	"sync/atomic"
)

// Metrics holds the worker's counters (atomic; updated from the consume loop).
type Metrics struct {
	Inserted     atomic.Int64 // rows successfully inserted into ClickHouse
	Skipped      atomic.Int64 // valid events with no target table (tool_call)
	DeadLettered atomic.Int64 // poison events routed to the DLQ
	InsertErrors atomic.Int64 // failed insert attempts (pre-retry/isolation)
}

// WritePrometheus renders counters in the Prometheus text exposition format.
func (m *Metrics) WritePrometheus(w io.Writer) {
	rows := []struct {
		name, help string
		val        int64
	}{
		{"chinsert_rows_inserted_total", "Rows successfully inserted into ClickHouse.", m.Inserted.Load()},
		{"chinsert_events_skipped_total", "Valid events with no target table.", m.Skipped.Load()},
		{"chinsert_events_deadlettered_total", "Poison events routed to the DLQ.", m.DeadLettered.Load()},
		{"chinsert_insert_errors_total", "Failed ClickHouse insert attempts.", m.InsertErrors.Load()},
	}
	for _, r := range rows {
		_, _ = fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", r.name, r.help, r.name, r.name, r.val)
	}
}
