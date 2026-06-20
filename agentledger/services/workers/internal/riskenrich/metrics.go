package riskenrich

import "sync/atomic"

// Metrics holds the worker's counters (atomic; safe across the pass loop and the
// admin HTTP handlers).
type Metrics struct {
	Runs             atomic.Int64 // enrichment passes executed
	BehaviorsScanned atomic.Int64 // run behaviors sent to the classifier
	FindingsRaised   atomic.Int64 // semantic risk_events written
	ClassifyErrors   atomic.Int64 // classifier calls that failed (skipped)
}
