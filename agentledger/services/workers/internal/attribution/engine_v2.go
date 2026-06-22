package attribution

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"time"
)

// EngineV2 is the staged attribution engine (build plan §4). Sub-phase 3.1 wires
// the DETERMINISTIC stage only: resolve hard links, persist method=deterministic
// edges to Postgres (the rich source of truth + training labels) and append
// attribution_events to ClickHouse.
//
// It runs in SHADOW behind ATTRIBUTION_ENGINE_V2 (ADR-040): it does NOT stamp
// outcomes.attribution_confidence — the V1 matcher still owns that column (and
// thus v_roi / v_outcome_graph) until V2 passes the calibration/precision gates
// on pilot data and the flag is flipped. Probabilistic (3.3), counterfactual
// (3.4), and Shapley (3.5) stages slot in after deterministic here.
type EngineV2 struct {
	ch           CHReaderV2
	pg           PGStore
	window       time.Duration
	lookbackDays int
	metrics      *V2Metrics
	now          func() time.Time
}

// V2Metrics counts the shadow-mode V2 pass (atomic).
type V2Metrics struct {
	Passes        atomic.Int64 // V2 passes executed
	Examined      atomic.Int64 // outcomes considered
	Deterministic atomic.Int64 // outcomes resolved to a deterministic link
	EdgesWritten  atomic.Int64 // attribution_edges rows upserted
}

// ModelVersionDeterministic is the lineage id stamped on deterministic edges. It
// carries no learned params — confidence is fixed by link strength; the scorer
// (3.3) and calibrator (3.7) register their own versions.
const ModelVersionDeterministic = "deterministic-v1"

// CHReaderV2 is the ClickHouse surface the V2 engine needs: the V1 reads/writes
// plus the evidence read and the attribution_events append. HTTPClient implements it.
type CHReaderV2 interface {
	CHClient
	FetchEvidence(ctx context.Context, since string) ([]EvidenceRow, error)
	WriteAttributionEvents(ctx context.Context, events []AttributionEvent) error
}

// NewEngineV2 builds the V2 engine over the given ClickHouse + Postgres stores.
func NewEngineV2(ch CHReaderV2, pg PGStore, window time.Duration, lookbackDays int, m *V2Metrics) *EngineV2 {
	if m == nil {
		m = &V2Metrics{}
	}
	return &EngineV2{ch: ch, pg: pg, window: window, lookbackDays: lookbackDays, metrics: m, now: time.Now}
}

// Process runs one deterministic attribution pass over the lookback window.
func (e *EngineV2) Process(ctx context.Context) error {
	e.metrics.Passes.Add(1)
	now := e.now().UTC()
	outcomeSince := now.AddDate(0, 0, -e.lookbackDays).Format(chTime)
	runSince := now.AddDate(0, 0, -e.lookbackDays).Add(-e.window).Format(chTime)

	outcomes, err := e.ch.FetchOutcomes(ctx, outcomeSince)
	if err != nil {
		return err
	}
	runs, err := e.ch.FetchRuns(ctx, runSince)
	if err != nil {
		return err
	}
	evidence, err := e.ch.FetchEvidence(ctx, outcomeSince)
	if err != nil {
		return err
	}

	// Ensure the deterministic model lineage exists before any edge references it.
	if err := e.pg.EnsureModelVersion(ctx, deterministicModelVersion()); err != nil {
		return err
	}

	runsByTenant := make(map[string][]RunRow, len(runs))
	for _, r := range runs {
		runsByTenant[r.TenantID] = append(runsByTenant[r.TenantID], r)
	}
	evByOutcome := make(map[string][]EvidenceRow, len(evidence))
	for _, ev := range evidence {
		k := ev.TenantID + "\x00" + ev.OutcomeID
		evByOutcome[k] = append(evByOutcome[k], ev)
	}

	edgesByTenant := make(map[string][]Edge)
	events := make([]AttributionEvent, 0)
	nowTS := now.Format(chTime)
	deterministic := 0

	for _, o := range outcomes {
		link, ok := ResolveDeterministic(o, runsByTenant[o.TenantID], evByOutcome[o.TenantID+"\x00"+o.OutcomeID])
		if !ok {
			continue
		}
		deterministic++

		contributions, _ := json.Marshal(evidenceContributions(link.Evidence))
		value := o.BusinessValueUSD
		cost := costForRun(runsByTenant[o.TenantID], link.RunID)

		edgesByTenant[o.TenantID] = append(edgesByTenant[o.TenantID], Edge{
			TenantID:             o.TenantID,
			OutcomeID:            o.OutcomeID,
			RunID:                link.RunID,
			AgentID:              link.AgentID,
			Method:               "deterministic",
			ConfidenceRaw:        link.Confidence,
			ConfidenceCalibrated: link.Confidence, // deterministic: calibration is identity
			SignalContributions:  contributions,
			ValueAttributed:      &value, // gross; 3.4 scales by the incremental share
			CostAttributed:       cost,
			ModelVersion:         ModelVersionDeterministic,
		})
		events = append(events, AttributionEvent{
			TS: nowTS, TenantID: o.TenantID, OutcomeID: o.OutcomeID, OutcomeType: o.OutcomeType,
			RunID: link.RunID, AgentID: link.AgentID, Method: "deterministic",
			ConfidenceRaw: link.Confidence, ConfidenceCalibrated: link.Confidence,
			ValueAttributed: value, CostAttributed: derefOr0(cost),
			ModelVersion: ModelVersionDeterministic, EngineVersion: "v2",
		})
	}

	written := 0
	for tenant, edges := range edgesByTenant {
		if err := e.pg.UpsertEdges(ctx, tenant, edges); err != nil {
			return err
		}
		written += len(edges)
	}
	if err := e.ch.WriteAttributionEvents(ctx, events); err != nil {
		return err
	}

	e.metrics.Examined.Add(int64(len(outcomes)))
	e.metrics.Deterministic.Add(int64(deterministic))
	e.metrics.EdgesWritten.Add(int64(written))
	slog.Info("attribution v2 deterministic pass complete",
		"examined", len(outcomes), "deterministic", deterministic, "edges", written)
	return nil
}

// deterministicModelVersion is the lineage row registered for deterministic edges.
func deterministicModelVersion() ModelVersion {
	return ModelVersion{
		Version: ModelVersionDeterministic,
		Kind:    "scorer",
		Params:  []byte(`{"method":"deterministic","sdk_stamp":1.0,"hard_evidence":0.97}`),
		Metrics: []byte(`{"precision":1.0,"note":"deterministic links — precision 1.0 by construction"}`),
		Active:  true,
	}
}

type signalContribution struct {
	Signal          string  `json:"signal"`
	WeightedLogOdds float64 `json:"weighted_log_odds"`
	EvidenceRef     string  `json:"evidence_ref,omitempty"`
}

// evidenceContributions renders deterministic evidence as signal_contributions so
// the audit UI shows the same shape for every edge (a deterministic edge's
// "contribution" is the evidence itself, with zero log-odds weight).
func evidenceContributions(ev []DeterministicEvidence) []signalContribution {
	out := make([]signalContribution, 0, len(ev))
	for _, e := range ev {
		out = append(out, signalContribution{Signal: e.Type, WeightedLogOdds: 0, EvidenceRef: e.Ref})
	}
	return out
}

func costForRun(runs []RunRow, runID string) *float64 {
	for _, r := range runs {
		if r.RunID == runID {
			c := r.TotalCostUSD
			return &c
		}
	}
	return nil
}

func derefOr0(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
