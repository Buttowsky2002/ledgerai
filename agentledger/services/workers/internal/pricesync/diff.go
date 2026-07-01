package pricesync

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Change describes one row delta between live and candidate price books.
type Change struct {
	Provider         string   `json:"provider"`
	Model            string   `json:"model"`
	TokenType        string   `json:"token_type"`
	OldUSDPerMillion *float64 `json:"old_usd_per_million,omitempty"`
	NewUSDPerMillion float64  `json:"new_usd_per_million"`
	PctChange        *float64 `json:"pct_change,omitempty"`
	Kind             string   `json:"kind"` // "new" | "changed" | "removed"
}

// DiffReport is the machine-readable diff written for human PR review.
type DiffReport struct {
	Changes     []Change  `json:"changes"`
	Unchanged   int       `json:"unchanged"`
	GeneratedAt time.Time `json:"generated_at"`
	FeedURL     string    `json:"feed_url"`
}

// Syncer orchestrates fetch → normalize → diff → atomic writes.
type Syncer struct {
	fetcher  *Fetcher
	livePath string
	outPath  string
	diffPath string
	alertPct float64
	metrics  *Metrics
	now      func() time.Time
}

// NewSyncer wires a pricesync pass. Output paths are owned by the worker; the live
// price book is read-only input for diffing — promotion is a human git PR, never
// a runtime write to pricing/pricebook.json or /etc/agentledger/pricing.
func NewSyncer(fetcher *Fetcher, livePath, outPath, diffPath string, alertPct float64, metrics *Metrics) *Syncer {
	if metrics == nil {
		metrics = &Metrics{}
	}
	return &Syncer{
		fetcher:  fetcher,
		livePath: livePath,
		outPath:  outPath,
		diffPath: diffPath,
		alertPct: alertPct,
		metrics:  metrics,
		now:      time.Now,
	}
}

// LivePath returns the read-only live price book path used for diffing.
func (s *Syncer) LivePath() string {
	return s.livePath
}

// Run executes one pricesync pass.
func (s *Syncer) Run(ctx context.Context) error {
	s.metrics.Runs.Add(1)
	runAt := s.now().UTC()
	s.metrics.LastRunUnix.Store(runAt.Unix())

	feed, err := s.fetcher.Fetch(ctx)
	if err != nil {
		return err
	}

	live, err := LoadPriceBook(s.livePath)
	if err != nil {
		return err
	}

	candidate := Normalize(feed, live, runAt, s.fetcher.FeedURL())
	report := Diff(live, candidate, s.fetcher.FeedURL(), runAt)

	s.metrics.Changes.Add(int64(len(report.Changes)))
	var changed, removed int64
	for _, c := range report.Changes {
		switch c.Kind {
		case "changed":
			changed++
		case "removed":
			removed++
		}
	}
	s.metrics.Changed.Add(changed)
	s.metrics.Removed.Add(removed)

	for _, c := range report.Changes {
		logAlert(c, s.alertPct)
	}

	if err := writePriceBookAtomic(s.outPath, candidate); err != nil {
		return fmt.Errorf("write candidate: %w", err)
	}
	if err := writeJSONAtomic(s.diffPath, report); err != nil {
		return fmt.Errorf("write diff: %w", err)
	}

	slog.Info("pricesync pass complete",
		"changes", len(report.Changes), "unchanged", report.Unchanged,
		"candidate", s.outPath, "diff", s.diffPath)
	return nil
}

// LoadPriceBook reads the live price book JSON array.
func LoadPriceBook(path string) ([]PriceEntry, error) {
	b, err := os.ReadFile(path) // #nosec G304 -- operator-provided path from env, not request input
	if err != nil {
		return nil, fmt.Errorf("read price book %q: %w", path, err)
	}
	var entries []PriceEntry
	if err := json.Unmarshal(b, &entries); err != nil {
		return nil, fmt.Errorf("parse price book %q: %w", path, err)
	}
	return entries, nil
}

// Diff compares candidate against live for tracked models only.
func Diff(live, candidate []PriceEntry, feedURL string, at time.Time) DiffReport {
	tracked := trackedModelSet()
	liveTracked := filterTracked(live, tracked)
	candIndex := indexLive(candidate)

	report := DiffReport{
		GeneratedAt: at.UTC(),
		FeedURL:     feedURL,
	}

	for key, liveRow := range liveTracked {
		candRow, ok := candIndex[key]
		if !ok {
			old := liveRow.USDPerMillion
			report.Changes = append(report.Changes, Change{
				Provider:         liveRow.Provider,
				Model:            liveRow.Model,
				TokenType:        liveRow.TokenType,
				OldUSDPerMillion: &old,
				NewUSDPerMillion: 0,
				Kind:             "removed",
			})
			continue
		}
		if ratesEqual(liveRow.USDPerMillion, candRow.USDPerMillion) {
			report.Unchanged++
			continue
		}
		old := liveRow.USDPerMillion
		newVal := candRow.USDPerMillion
		ch := Change{
			Provider:         liveRow.Provider,
			Model:            liveRow.Model,
			TokenType:        liveRow.TokenType,
			OldUSDPerMillion: &old,
			NewUSDPerMillion: newVal,
			Kind:             "changed",
		}
		if pct := pctChange(old, newVal); pct != nil {
			ch.PctChange = pct
		}
		report.Changes = append(report.Changes, ch)
	}

	for key, candRow := range candIndex {
		if !tracked[key] {
			continue
		}
		if _, ok := liveTracked[key]; ok {
			continue
		}
		report.Changes = append(report.Changes, Change{
			Provider:         candRow.Provider,
			Model:            candRow.Model,
			TokenType:        candRow.TokenType,
			NewUSDPerMillion: candRow.USDPerMillion,
			Kind:             "new",
		})
	}

	return report
}

func trackedModelSet() map[string]bool {
	m := make(map[string]bool, len(trackedModels))
	for _, mapping := range trackedModels {
		m[rowKey(mapping.Provider, mapping.Model, "input")] = true
		m[rowKey(mapping.Provider, mapping.Model, "output")] = true
		m[rowKey(mapping.Provider, mapping.Model, "cache_read")] = true
		m[rowKey(mapping.Provider, mapping.Model, "cache_write")] = true
	}
	return m
}

func filterTracked(live []PriceEntry, tracked map[string]bool) map[string]PriceEntry {
	out := make(map[string]PriceEntry)
	for _, e := range live {
		if !isTrackedModel(e.Model) {
			continue
		}
		key := rowKey(e.Provider, e.Model, e.TokenType)
		if tracked[key] {
			out[key] = e
		}
	}
	return out
}

func isTrackedModel(model string) bool {
	for _, mapping := range trackedModels {
		if mapping.Model == model {
			return true
		}
	}
	return false
}

func pctChange(old, newVal float64) *float64 {
	if old == 0 {
		return nil
	}
	p := (newVal - old) / old * 100
	p = math.Round(p*1e6) / 1e6
	return &p
}

func logAlert(c Change, alertPct float64) {
	if c.PctChange == nil {
		return
	}
	if math.Abs(*c.PctChange) <= alertPct {
		return
	}
	slog.Warn("pricesync price change exceeds alert threshold",
		"provider", c.Provider, "model", c.Model, "token_type", c.TokenType,
		"kind", c.Kind, "old_usd_per_million", c.OldUSDPerMillion,
		"new_usd_per_million", c.NewUSDPerMillion, "pct_change", *c.PctChange)
}

func writePriceBookAtomic(path string, entries []PriceEntry) error {
	data, err := MarshalPriceBook(entries)
	if err != nil {
		return err
	}
	return writeBytesAtomic(path, data)
}

func writeJSONAtomic(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writeBytesAtomic(path, data)
}

func writeBytesAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".pricesync-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// MarshalPriceBook encodes entries in the repo's flat-array, one-object-per-line shape.
func MarshalPriceBook(entries []PriceEntry) ([]byte, error) {
	var b strings.Builder
	b.WriteString("[\n")
	for i, e := range entries {
		if i > 0 {
			b.WriteString(",\n")
		}
		line, err := marshalPriceEntryLine(e)
		if err != nil {
			return nil, err
		}
		b.WriteString("  ")
		b.WriteString(line)
	}
	b.WriteString("\n]\n")
	return []byte(b.String()), nil
}

func marshalPriceEntryLine(e PriceEntry) (string, error) {
	start, err := json.Marshal(e.EffectiveStart.UTC())
	if err != nil {
		return "", err
	}
	parts := []string{
		`"provider":` + jsonString(e.Provider),
		`"model":` + jsonString(e.Model),
		`"token_type":` + jsonString(e.TokenType),
		`"usd_per_million":` + formatUSDPerMillion(e.USDPerMillion),
		`"effective_start":` + string(start),
	}
	if e.EffectiveEnd != nil {
		end, err := json.Marshal(e.EffectiveEnd.UTC())
		if err != nil {
			return "", err
		}
		parts = append(parts, `"effective_end":`+string(end))
	}
	parts = append(parts, `"source":`+jsonString(e.Source))
	return "{" + strings.Join(parts, ",") + "}", nil
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func formatUSDPerMillion(v float64) string {
	v = math.Round(v*1e6) / 1e6
	s := strconv.FormatFloat(v, 'f', -1, 64)
	if strings.Contains(s, ".") {
		return s
	}
	return s + ".0"
}
