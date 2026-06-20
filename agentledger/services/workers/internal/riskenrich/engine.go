package riskenrich

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"time"
)

// Config tunes a semantic enrichment pass.
type Config struct {
	LookbackHours int     // how far back to scan agent_tool_calls
	MinCalls      int     // ignore runs with fewer tool calls than this
	MinConfidence float64 // drop findings below this confidence (clearly-probabilistic gate)
}

// Engine runs one semantic enrichment pass: read recent behaviors, classify each
// via the LLM tier, and write confident findings as governed risk_events.
type Engine struct {
	ch         CHClient
	classifier Classifier
	cfg        Config
	metrics    *Metrics
	now        func() time.Time
}

// New builds an enrichment Engine. Defaults are applied for any zero Config field.
func New(ch CHClient, classifier Classifier, cfg Config, m *Metrics) *Engine {
	if cfg.LookbackHours <= 0 {
		cfg.LookbackHours = 24
	}
	if cfg.MinCalls <= 0 {
		cfg.MinCalls = 2
	}
	if cfg.MinConfidence <= 0 {
		cfg.MinConfidence = 0.5
	}
	if m == nil {
		m = &Metrics{}
	}
	return &Engine{ch: ch, classifier: classifier, cfg: cfg, metrics: m, now: time.Now}
}

// Run executes one enrichment pass. A classifier error on one behavior is logged
// and skipped so a single bad run never stalls the pass.
func (e *Engine) Run(ctx context.Context) error {
	e.metrics.Runs.Add(1)
	behaviors, err := e.ch.AgentBehaviors(ctx, e.cfg.LookbackHours, e.cfg.MinCalls)
	if err != nil {
		return fmt.Errorf("read behaviors: %w", err)
	}

	now := e.now().UTC().Format("2006-01-02 15:04:05.000")
	var events []RiskEvent
	for _, b := range behaviors {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		e.metrics.BehaviorsScanned.Add(1)
		assessment, err := e.classifier.Classify(ctx, b)
		if err != nil {
			e.metrics.ClassifyErrors.Add(1)
			slog.Warn("classify failed", "agent", b.AgentID, "run", b.RunID, "err", err)
			continue
		}
		for _, f := range assessment.Findings {
			if f.Category == "" || f.Category == "none" {
				continue
			}
			if f.Confidence < e.cfg.MinConfidence {
				continue
			}
			category := "semantic_" + f.Category
			events = append(events, RiskEvent{
				EventID:     semanticEventID(b.TenantID, b.AgentID, b.RunID, category),
				TenantID:    b.TenantID,
				AgentID:     b.AgentID,
				RunID:       b.RunID,
				Category:    category,
				Severity:    normalizeSeverity(f.Severity),
				Detail:      fmt.Sprintf("tier=semantic confidence=%.2f; %s", f.Confidence, f.Rationale),
				Occurrences: 1,
				FirstSeen:   now,
				DetectedAt:  now,
			})
		}
	}

	if len(events) == 0 {
		return nil
	}
	if err := e.ch.WriteRiskEvents(ctx, events); err != nil {
		return fmt.Errorf("write risk events: %w", err)
	}
	e.metrics.FindingsRaised.Add(int64(len(events)))
	return nil
}

// semanticEventID is deterministic per (tenant, agent, run, category) so repeated
// passes upsert the same risk_events row rather than duplicating it.
func semanticEventID(tenant, agent, run, category string) string {
	sum := sha256.Sum256([]byte(tenant + "|" + agent + "|" + run + "|" + category))
	return "se_" + hex.EncodeToString(sum[:8])
}

func normalizeSeverity(s string) string {
	switch s {
	case "low", "medium", "high":
		return s
	default:
		return "low"
	}
}
