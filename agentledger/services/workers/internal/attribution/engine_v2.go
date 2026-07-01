package attribution

import (
	"context"
	"encoding/json"
	"log/slog"
	"sort"
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
	ch            CHReaderV2
	pg            PGStore
	window        time.Duration
	lookbackDays  int
	scorer        ScorerModel  // probabilistic stage (3.3)
	config        SignalConfig // signal-extraction config (3.2)
	minConfidence float64      // below this a probabilistic edge is not written
	metrics       *V2Metrics
	now           func() time.Time
}

// V2Metrics counts the shadow-mode V2 pass (atomic).
type V2Metrics struct {
	Passes        atomic.Int64 // V2 passes executed
	Examined      atomic.Int64 // outcomes considered
	Deterministic atomic.Int64 // outcomes resolved to a deterministic link
	Probabilistic atomic.Int64 // outcomes scored to a probabilistic link
	Coalitions    atomic.Int64 // outcomes resolved to a multi-agent coalition
	EdgesWritten  atomic.Int64 // attribution_edges rows upserted
	Stamped       atomic.Int64 // outcomes re-inserted with V2 winning edge (cutover)
}

// ModelVersionDeterministic is the lineage id stamped on deterministic edges. It
// carries no learned params — confidence is fixed by link strength; the scorer
// (3.3) and calibrator (3.7) register their own versions.
const ModelVersionDeterministic = "deterministic-v1"

// ModelVersionCounterfactual is the lineage id for the baseline/counterfactual
// estimator (3.4), referenced by attribution_baselines.
const ModelVersionCounterfactual = "counterfactual-v1"

// ModelVersionShapley is the lineage id stamped on coalition (multi-agent) edges (3.5).
const ModelVersionShapley = "shapley-v1"

// CHReaderV2 is the ClickHouse surface the V2 engine needs: the V1 reads/writes
// plus the evidence read and the attribution_events append. HTTPClient implements it.
type CHReaderV2 interface {
	CHClient
	FetchEvidence(ctx context.Context, since string) ([]EvidenceRow, error)
	WriteAttributionEvents(ctx context.Context, events []AttributionEvent) error
}

// NewEngineV2 builds the V2 engine over the given ClickHouse + Postgres stores,
// with the hand-set scorer prior + default signal config (the worker may swap in a
// fitted model via WithScorer).
func NewEngineV2(ch CHReaderV2, pg PGStore, window time.Duration, lookbackDays int, m *V2Metrics) *EngineV2 {
	if m == nil {
		m = &V2Metrics{}
	}
	return &EngineV2{
		ch: ch, pg: pg, window: window, lookbackDays: lookbackDays,
		scorer: DefaultScorerModel(), config: DefaultSignalConfig(), minConfidence: 0.3,
		metrics: m, now: time.Now,
	}
}

// WithScorer swaps in a fitted scorer model and the minimum calibrated confidence
// below which a probabilistic edge is not written.
func (e *EngineV2) WithScorer(model ScorerModel, minConfidence float64) *EngineV2 {
	e.scorer = model
	e.minConfidence = minConfidence
	return e
}

// Process runs one V2 attribution pass over the lookback window. When stamp is
// true (cutover mode, ADR-040), the winning edge per outcome is written back to
// ClickHouse outcomes; otherwise the pass is shadow-only.
func (e *EngineV2) Process(ctx context.Context, stamp bool) error {
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

	known, err := e.pg.KnownTenants(ctx, collectTenantIDs(outcomes, runs, evidence))
	if err != nil {
		return err
	}
	rawCount := len(outcomes)
	outcomes = filterOutcomesByTenant(outcomes, known)
	runs = filterRunsByTenant(runs, known)
	evidence = filterEvidenceByTenant(evidence, known)
	if skipped := rawCount - len(outcomes); skipped > 0 {
		slog.Warn("attribution v2 skipped outcomes for unknown tenants", "skipped", skipped)
	}

	// Ensure all model lineages exist before any edge/baseline references them (FK).
	for _, mv := range []ModelVersion{deterministicModelVersion(), scorerModelVersion(e.scorer), counterfactualModelVersion(), shapleyModelVersion()} {
		if err := e.pg.EnsureModelVersion(ctx, mv); err != nil {
			return err
		}
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

	// Phase 1 — resolve a tentative edge per attributable outcome (GROSS value),
	// and record which outcomes were treated (for the counterfactual baseline).
	type tentative struct {
		o     OutcomeRow
		edge  Edge
		event AttributionEvent
		gross float64
	}
	tents := make([]tentative, 0, len(outcomes))
	treated := make(map[string]bool)
	coalitionsByTenant := make(map[string][]Coalition)
	nowTS := now.Format(chTime)
	deterministic, probabilistic, coalitions := 0, 0, 0

	for _, o := range outcomes {
		tRuns := runsByTenant[o.TenantID]
		ev := evByOutcome[o.TenantID+"\x00"+o.OutcomeID]

		// Stage 0 — coalition: ≥2 distinct agents contributed → Shapley-allocate the
		// value across them (one edge per member), instead of a single winner.
		if contribs := e.gatherContributors(o, tRuns, ev); len(contribs) >= 2 {
			coalitions++
			col := ShapleyAllocate(contribs, shapleySeed(o.TenantID, o.OutcomeID))
			col.TenantID, col.OutcomeID = o.TenantID, o.OutcomeID
			col.CoalitionID = deterministicCoalitionID(o.TenantID, o.OutcomeID)
			coalitionsByTenant[o.TenantID] = append(coalitionsByTenant[o.TenantID], col)
			cid := col.CoalitionID
			for _, m := range col.Members {
				gross := o.BusinessValueUSD * m.ShapleyValue
				cost := m.CostUSD
				tents = append(tents, tentative{o: o, gross: gross,
					edge: Edge{
						TenantID: o.TenantID, OutcomeID: o.OutcomeID, RunID: m.RunID, AgentID: m.AgentID,
						CoalitionID: &cid, Method: "shapley", ConfidenceRaw: m.Confidence, ConfidenceCalibrated: m.Confidence,
						SignalContributions: contributorContribs(contribs, m.AgentID), CostAttributed: &cost,
						ModelVersion: ModelVersionShapley,
					},
					event: AttributionEvent{
						TS: nowTS, TenantID: o.TenantID, OutcomeID: o.OutcomeID, OutcomeType: o.OutcomeType,
						RunID: m.RunID, AgentID: m.AgentID, CoalitionID: cid, Method: "shapley",
						ConfidenceRaw: m.Confidence, ConfidenceCalibrated: m.Confidence, CostAttributed: cost,
						ModelVersion: ModelVersionShapley, EngineVersion: "v2",
					}})
			}
			treated[o.TenantID+"\x00"+o.OutcomeID] = true
			continue
		}

		if link, ok := ResolveDeterministic(o, tRuns, ev); ok {
			deterministic++
			contributions, _ := json.Marshal(evidenceContributions(link.Evidence))
			cost := costForRun(tRuns, link.RunID)
			tents = append(tents, tentative{o: o, gross: o.BusinessValueUSD,
				edge: Edge{
					TenantID: o.TenantID, OutcomeID: o.OutcomeID, RunID: link.RunID, AgentID: link.AgentID,
					Method: "deterministic", ConfidenceRaw: link.Confidence, ConfidenceCalibrated: link.Confidence,
					SignalContributions: contributions, CostAttributed: cost, ModelVersion: ModelVersionDeterministic,
				},
				event: AttributionEvent{
					TS: nowTS, TenantID: o.TenantID, OutcomeID: o.OutcomeID, OutcomeType: o.OutcomeType,
					RunID: link.RunID, AgentID: link.AgentID, Method: "deterministic",
					ConfidenceRaw: link.Confidence, ConfidenceCalibrated: link.Confidence,
					CostAttributed: derefOr0(cost), ModelVersion: ModelVersionDeterministic, EngineVersion: "v2",
				}})
			treated[o.TenantID+"\x00"+o.OutcomeID] = true
			continue
		}
		if edge, ev, ok := e.scoreProbabilistic(o, tRuns, nowTS); ok {
			probabilistic++
			tents = append(tents, tentative{o: o, gross: o.BusinessValueUSD, edge: edge, event: ev})
			treated[o.TenantID+"\x00"+o.OutcomeID] = true
		}
	}

	// Phase 2 — counterfactual baselines from the full outcome set + treated marks.
	baselines := ComputeBaselines(outcomes, treated)

	// Phase 3 — scale each edge's value to the INCREMENTAL share (§3.4) and stamp
	// counterfactual_delta. value_attributed = gross × delta; ROI consumes this
	// (incremental, confidence-weighted) at cutover (ADR-040/042).
	edgesByTenant := make(map[string][]Edge)
	events := make([]AttributionEvent, 0, len(tents))
	for _, t := range tents {
		delta, _, _ := deltaFor(baselines, t.o)
		incremental := t.gross * delta
		t.edge.CounterfactualDelta = &delta
		t.edge.ValueAttributed = &incremental
		t.event.CounterfactualDelta = delta
		t.event.ValueAttributed = incremental
		edgesByTenant[t.edge.TenantID] = append(edgesByTenant[t.edge.TenantID], t.edge)
		events = append(events, t.event)
	}

	// Persist baselines (per tenant), stamped with the pass window.
	baselinesByTenant := make(map[string][]Baseline)
	for _, b := range baselines {
		b.WindowStart, b.WindowEnd = outcomeSince, nowTS
		baselinesByTenant[b.TenantID] = append(baselinesByTenant[b.TenantID], b)
	}
	for tenant, bs := range baselinesByTenant {
		if err := e.pg.UpsertBaselines(ctx, tenant, bs); err != nil {
			return err
		}
	}
	// Coalitions BEFORE edges so the edges' coalition_id FK resolves.
	for tenant, cols := range coalitionsByTenant {
		if err := e.pg.UpsertCoalitions(ctx, tenant, cols); err != nil {
			return err
		}
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

	if stamp {
		allEdges := make([]Edge, 0, written)
		for _, edges := range edgesByTenant {
			allEdges = append(allEdges, edges...)
		}
		if err := e.stampWinningOutcomes(ctx, outcomes, allEdges); err != nil {
			return err
		}
	}

	e.metrics.Examined.Add(int64(len(outcomes)))
	e.metrics.Deterministic.Add(int64(deterministic))
	e.metrics.Probabilistic.Add(int64(probabilistic))
	e.metrics.Coalitions.Add(int64(coalitions))
	e.metrics.EdgesWritten.Add(int64(written))
	slog.Info("attribution v2 pass complete",
		"examined", len(outcomes), "deterministic", deterministic, "probabilistic", probabilistic,
		"coalitions", coalitions, "baselines", len(baselines), "edges", written, "stamp", stamp)
	return nil
}

// counterfactualModelVersion is the lineage row for the baseline estimator.
func counterfactualModelVersion() ModelVersion {
	return ModelVersion{
		Version: ModelVersionCounterfactual, Kind: "baseline",
		Params:  []byte(`{"method":"share_based","formula":"1 - baseline/total","min_sample":4}`),
		Metrics: []byte(`{}`), Active: true,
	}
}

// shapleyModelVersion is the lineage row for the coalition allocator.
func shapleyModelVersion() ModelVersion {
	return ModelVersion{
		Version: ModelVersionShapley, Kind: "scorer",
		Params:  []byte(`{"method":"shapley","characteristic":"noisy_or","exact_max":5,"mc_samples":20000}`),
		Metrics: []byte(`{}`), Active: true,
	}
}

// gatherContributors returns one best contributing run per agent for an outcome:
// any hard link (SDK stamp or evidence naming a run), plus probabilistic candidates
// clearing minConfidence. ≥2 distinct agents means a coalition (Shapley). Sorted by
// agent_id for deterministic allocation order.
func (e *EngineV2) gatherContributors(o OutcomeRow, runs []RunRow, evidence []EvidenceRow) []contributor {
	best := make(map[string]contributor)
	add := func(c contributor) {
		if c.agentID == "" {
			return
		}
		if ex, ok := best[c.agentID]; !ok || c.conf > ex.conf {
			best[c.agentID] = c
		}
	}
	ref := deriveOutcomeRef(o.OutcomeID, o.SourceSystem)
	for _, r := range runs {
		switch {
		case r.OutcomeID != "" && r.OutcomeID == o.OutcomeID:
			cj, _ := json.Marshal([]signalContribution{{Signal: "sdk_session_link", EvidenceRef: ref}})
			add(contributor{r.AgentID, r.RunID, ConfSDKStamp, "deterministic", r.TotalCostUSD, cj})
		case evidenceNamesRun(evidence, o.OutcomeID, r.RunID) != "":
			et := evidenceNamesRun(evidence, o.OutcomeID, r.RunID)
			cj, _ := json.Marshal([]signalContribution{{Signal: et, EvidenceRef: ref}})
			add(contributor{r.AgentID, r.RunID, ConfHardEvidence, "deterministic", r.TotalCostUSD, cj})
		default:
			gap, ok := candidateGap(SignalInput{Outcome: o, Run: r})
			if !ok || gap < 0 || gap > e.window {
				continue
			}
			_, cal, contribs := e.scorer.Score(ExtractSignals(SignalInput{Outcome: o, Run: r, Config: e.config}))
			if cal >= e.minConfidence {
				cj, _ := json.Marshal(contribs)
				add(contributor{r.AgentID, r.RunID, cal, "probabilistic", r.TotalCostUSD, cj})
			}
		}
	}
	out := make([]contributor, 0, len(best))
	for _, c := range best {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].agentID < out[j].agentID })
	return out
}

// evidenceNamesRun returns the evidence_type when an evidence row concretely names
// the given run for the outcome, else "".
func evidenceNamesRun(evidence []EvidenceRow, outcomeID, runID string) string {
	for _, ev := range evidence {
		if ev.OutcomeID == outcomeID && ev.RunID == runID {
			return ev.EvidenceType
		}
	}
	return ""
}

// contributorContribs returns the signal_contributions JSON for a coalition member.
func contributorContribs(contribs []contributor, agentID string) []byte {
	for _, c := range contribs {
		if c.agentID == agentID {
			return c.contribs
		}
	}
	return []byte("[]")
}

// scoreProbabilistic generates candidate runs for an outcome (recall-first: in the
// tenant, ending within [0, window] before the outcome), extracts signals, scores
// each with the model, and returns the single best edge when its calibrated
// confidence clears minConfidence. The signal_contributions on the edge are the
// score's explanation (3.3, non-negotiable).
func (e *EngineV2) scoreProbabilistic(o OutcomeRow, runs []RunRow, nowTS string) (Edge, AttributionEvent, bool) {
	bestCal, bestRaw := 0.0, 0.0
	var bestRun RunRow
	var bestContribs []Contribution
	found := false
	for _, r := range runs {
		gap, ok := candidateGap(SignalInput{Outcome: o, Run: r})
		if !ok || gap < 0 || gap > e.window {
			continue
		}
		sigs := ExtractSignals(SignalInput{Outcome: o, Run: r, Config: e.config})
		raw, cal, contribs := e.scorer.Score(sigs)
		if !found || cal > bestCal {
			bestCal, bestRaw, bestRun, bestContribs, found = cal, raw, r, contribs, true
		}
	}
	if !found || bestCal < e.minConfidence {
		return Edge{}, AttributionEvent{}, false
	}
	contribJSON, _ := json.Marshal(bestContribs)
	value := o.BusinessValueUSD
	cost := bestRun.TotalCostUSD
	edge := Edge{
		TenantID: o.TenantID, OutcomeID: o.OutcomeID, RunID: bestRun.RunID, AgentID: bestRun.AgentID,
		Method: "probabilistic", ConfidenceRaw: bestRaw, ConfidenceCalibrated: bestCal,
		SignalContributions: contribJSON, ValueAttributed: &value, CostAttributed: &cost,
		ModelVersion: e.scorer.Version,
	}
	ev := AttributionEvent{
		TS: nowTS, TenantID: o.TenantID, OutcomeID: o.OutcomeID, OutcomeType: o.OutcomeType,
		RunID: bestRun.RunID, AgentID: bestRun.AgentID, Method: "probabilistic",
		ConfidenceRaw: bestRaw, ConfidenceCalibrated: bestCal,
		ValueAttributed: value, CostAttributed: cost,
		ModelVersion: e.scorer.Version, EngineVersion: "v2",
	}
	return edge, ev, true
}

// scorerModelVersion builds the attribution_model_versions row for a scorer model
// (its full params JSON, so any score is reproducible — rule 10).
func scorerModelVersion(m ScorerModel) ModelVersion {
	params, _ := json.Marshal(m)
	return ModelVersion{Version: m.Version, Kind: "scorer", Params: params, Metrics: []byte(`{}`), Active: true}
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
