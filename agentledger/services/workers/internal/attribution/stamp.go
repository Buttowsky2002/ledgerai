package attribution

import (
	"context"
	"math"
)

// stampWinningOutcomes writes the highest-confidence V2 edge per outcome back to
// ClickHouse outcomes (ADR-040 cutover). Coalition outcomes pick the member edge
// with the greatest calibrated confidence — the CH contract is one run_id column.
func (e *EngineV2) stampWinningOutcomes(ctx context.Context, outcomes []OutcomeRow, edges []Edge) error {
	if len(edges) == 0 {
		return nil
	}
	best := make(map[string]Edge, len(edges))
	for _, edge := range edges {
		if edge.ConfidenceCalibrated < e.minConfidence {
			continue
		}
		key := edge.TenantID + "\x00" + edge.OutcomeID
		if cur, ok := best[key]; !ok || edge.ConfidenceCalibrated > cur.ConfidenceCalibrated {
			best[key] = edge
		}
	}
	changed := make([]OutcomeRow, 0)
	for _, o := range outcomes {
		edge, ok := best[o.TenantID+"\x00"+o.OutcomeID]
		if !ok {
			continue
		}
		if edge.RunID != o.RunID || math.Abs(edge.ConfidenceCalibrated-o.AttributionConfidence) > confEpsilon {
			o.RunID = edge.RunID
			o.AttributionConfidence = edge.ConfidenceCalibrated
			changed = append(changed, o)
		}
	}
	if len(changed) == 0 {
		return nil
	}
	if err := e.ch.WriteOutcomes(ctx, changed); err != nil {
		return err
	}
	e.metrics.Stamped.Add(int64(len(changed)))
	return nil
}

func collectTenantIDs(outcomes []OutcomeRow, runs []RunRow, evidence []EvidenceRow) []string {
	seen := make(map[string]struct{})
	add := func(id string) {
		if id != "" {
			seen[id] = struct{}{}
		}
	}
	for _, o := range outcomes {
		add(o.TenantID)
	}
	for _, r := range runs {
		add(r.TenantID)
	}
	for _, ev := range evidence {
		add(ev.TenantID)
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	return ids
}

func filterOutcomesByTenant(outcomes []OutcomeRow, known map[string]bool) []OutcomeRow {
	if len(known) == 0 {
		return outcomes
	}
	out := make([]OutcomeRow, 0, len(outcomes))
	for _, o := range outcomes {
		if known[o.TenantID] {
			out = append(out, o)
		}
	}
	return out
}

func filterRunsByTenant(runs []RunRow, known map[string]bool) []RunRow {
	if len(known) == 0 {
		return runs
	}
	out := make([]RunRow, 0, len(runs))
	for _, r := range runs {
		if known[r.TenantID] {
			out = append(out, r)
		}
	}
	return out
}

func filterEvidenceByTenant(evidence []EvidenceRow, known map[string]bool) []EvidenceRow {
	if len(known) == 0 {
		return evidence
	}
	out := make([]EvidenceRow, 0, len(evidence))
	for _, ev := range evidence {
		if known[ev.TenantID] {
			out = append(out, ev)
		}
	}
	return out
}
