package attribution

import (
	"context"
	"log/slog"
	"math"
	"strings"
	"sync/atomic"
	"time"
)

// chTime is the timestamp layout ClickHouse toString() emits for DateTime64(3).
const chTime = "2006-01-02 15:04:05.000"

// confEpsilon guards re-writes against Float32 round-trip noise: a row is only
// re-inserted when run_id changes or confidence moves by more than this.
const confEpsilon = 1e-3

// Scoring weights (sum capped at 0.99; a direct SDK link scores 1.0).
const (
	wTime     = 0.4 // time proximity at the moment the run ended
	wIdentity = 0.4 // outcome.user_id == run.user_id
	wToken    = 0.2 // outcome key (issue/PR) appears in run.objective
)

// Metrics holds attribution counters (atomic).
type Metrics struct {
	Runs       atomic.Int64 // matcher passes executed
	Examined   atomic.Int64 // outcomes scored
	Attributed atomic.Int64 // outcomes that matched a run (confidence > 0)
	Updated    atomic.Int64 // outcome rows re-inserted (changed)
}

// Matcher correlates outcomes to the agent runs that produced them and writes
// run_id + attribution_confidence back onto the outcomes table.
type Matcher struct {
	ch            CHClient
	window        time.Duration // max gap between a run ending and the outcome
	lookbackDays  int           // window of outcomes (re)attributed each pass
	minConfidence float64       // below this an outcome is left unattributed
	metrics       *Metrics
	now           func() time.Time
}

// New builds a Matcher that correlates outcomes to agent runs within the given
// time window and lookback, emitting links at or above minConfidence.
func New(ch CHClient, window time.Duration, lookbackDays int, minConfidence float64, m *Metrics) *Matcher {
	if m == nil {
		m = &Metrics{}
	}
	return &Matcher{
		ch:            ch,
		window:        window,
		lookbackDays:  lookbackDays,
		minConfidence: minConfidence,
		metrics:       m,
		now:           time.Now,
	}
}

// Run performs one attribution pass over the last lookbackDays of outcomes.
func (m *Matcher) Run(ctx context.Context) error {
	m.metrics.Runs.Add(1)
	now := m.now().UTC()
	outcomeSince := now.AddDate(0, 0, -m.lookbackDays).Format(chTime)
	// Runs are fetched a window earlier so a run that ended just before the
	// oldest outcome is still a candidate.
	runSince := now.AddDate(0, 0, -m.lookbackDays).Add(-m.window).Format(chTime)

	outcomes, err := m.ch.FetchOutcomes(ctx, outcomeSince)
	if err != nil {
		return err
	}
	runs, err := m.ch.FetchRuns(ctx, runSince)
	if err != nil {
		return err
	}

	byTenant := make(map[string][]RunRow, len(runs))
	for _, r := range runs {
		byTenant[r.TenantID] = append(byTenant[r.TenantID], r)
	}

	changed := make([]OutcomeRow, 0)
	attributed := 0
	for _, o := range outcomes {
		runID, conf := m.match(o, byTenant[o.TenantID])
		if conf > 0 {
			attributed++
		}
		if runID != o.RunID || math.Abs(conf-o.AttributionConfidence) > confEpsilon {
			o.RunID = runID
			o.AttributionConfidence = conf
			changed = append(changed, o)
		}
	}

	if err := m.ch.WriteOutcomes(ctx, changed); err != nil {
		return err
	}

	m.metrics.Examined.Add(int64(len(outcomes)))
	m.metrics.Attributed.Add(int64(attributed))
	m.metrics.Updated.Add(int64(len(changed)))
	slog.Info("attribution pass complete",
		"examined", len(outcomes), "attributed", attributed, "updated", len(changed))
	return nil
}

// match returns the best (run_id, confidence) for an outcome among its tenant's
// runs. A direct SDK link scores 1.0; otherwise time + identity + issue-token
// signals are summed and gated by minConfidence.
func (m *Matcher) match(o OutcomeRow, runs []RunRow) (string, float64) {
	ots, err := time.Parse(chTime, o.TS)
	if err != nil {
		return "", 0
	}

	tokens := outcomeKeyTokens(o.OutcomeID)
	bestRunID := ""
	bestConf := 0.0
	var bestEnded time.Time

	for _, r := range runs {
		// Direct link asserted by the SDK — strongest possible signal.
		if o.OutcomeID != "" && r.OutcomeID == o.OutcomeID {
			return r.RunID, 1.0
		}

		ended, err := time.Parse(chTime, r.EndedAt)
		if err != nil {
			continue
		}
		dt := ots.Sub(ended)
		if dt < 0 || dt > m.window {
			continue // run ended after the outcome, or too long before it
		}

		score := wTime * (1 - float64(dt)/float64(m.window))
		if r.UserID != "" && r.UserID == o.UserID {
			score += wIdentity
		}
		if objectiveHasToken(r.Objective, tokens) {
			score += wToken
		}

		if score > bestConf || (score == bestConf && ended.After(bestEnded)) {
			bestConf = score
			bestRunID = r.RunID
			bestEnded = ended
		}
	}

	if bestConf > 0.99 {
		bestConf = 0.99
	}
	bestConf = math.Round(bestConf*1e4) / 1e4
	if bestConf < m.minConfidence {
		return "", 0
	}
	return bestRunID, bestConf
}

// outcomeKeyTokens extracts the external key from an outcome_id (the part after
// the first ':') plus its "#NN" fragment, keeping only tokens long enough to be
// distinctive (avoids matching bare short numbers in free-text objectives).
func outcomeKeyTokens(outcomeID string) []string {
	i := strings.IndexByte(outcomeID, ':')
	if i < 0 || i == len(outcomeID)-1 {
		return nil
	}
	key := outcomeID[i+1:]
	var toks []string
	if len(key) >= 3 {
		toks = append(toks, key)
	}
	if h := strings.LastIndexByte(key, '#'); h >= 0 {
		if frag := key[h:]; len(frag) >= 3 {
			toks = append(toks, frag)
		}
	}
	return toks
}

func objectiveHasToken(objective string, tokens []string) bool {
	if objective == "" || len(tokens) == 0 {
		return false
	}
	obj := strings.ToLower(objective)
	for _, tok := range tokens {
		if strings.Contains(obj, strings.ToLower(tok)) {
			return true
		}
	}
	return false
}
