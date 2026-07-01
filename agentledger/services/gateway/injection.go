package main

import (
	"regexp"
	"strings"
	"unicode"
)

// InjectionEngine implements deterministic prompt-injection detection on the
// inline path (regex + rune scan only — zero I/O). It does not catch all
// injection; it blocks known high-confidence patterns and flags the rest for
// async enrichment. Residual risk remains (ADR-048).
//
// The inline path only ever sees request text transiently; emitted events carry
// class/severity/action metadata — never raw matched content.

// InjectionFinding is one detector hit; like dlp.Finding it carries metadata
// but never the raw matched span.
type InjectionFinding struct {
	Class      string  `json:"class"`    // e.g. "instruction_override"
	Source     string  `json:"source"`   // "prompt" | "tool_result"
	Severity   string  `json:"severity"` // low | medium | high | critical
	Confidence float64 `json:"confidence"`
	Count      int     `json:"count"`
}

type injectionRule struct {
	class    string
	severity string
	conf     float64
	re       *regexp.Regexp
}

// InjectionEngine applies deterministic injection rules and per-policy actions
// to prompt and tool_result text on the inline path.
type InjectionEngine struct {
	cfg      injectionRuntimeConfig
	rules    []injectionRule
	policies map[string]InjectionPolicy
}

// injectionRuntimeConfig is the resolved InjectionConfig with defaults applied.
type injectionRuntimeConfig struct {
	Enabled            bool
	BlockMinConfidence float64
	ScanToolResults    bool
}

// NewInjectionEngine builds an InjectionEngine from cfg, indexing policies by ID.
func NewInjectionEngine(cfg InjectionConfig) *InjectionEngine {
	rt := resolveInjectionConfig(cfg)
	pol := map[string]InjectionPolicy{}
	for _, p := range cfg.Policies {
		pol[p.ID] = p
	}
	return &InjectionEngine{
		cfg:      rt,
		policies: pol,
		rules: []injectionRule{
			{"instruction_override", "high", 0.85,
				regexp.MustCompile(`(?i)(?:\bignore (?:all )?(?:previous|prior) instructions\b|\bdisregard the above\b|\bforget everything\b)`)},
			{"role_hijack", "high", 0.8,
				regexp.MustCompile(`(?i)(?:\byou are now (?:a|an)\b|\bfrom now on you (?:are|will)\b|\bnew system prompt:)`)},
			{"system_prompt_exfil", "high", 0.9,
				regexp.MustCompile(`(?i)(?:\b(?:repeat|print|reveal) (?:your )?(?:system )?prompt\b|\bwhat are your instructions\b)`)},
			{"tool_smuggle", "critical", 0.9,
				regexp.MustCompile(`(?i)(?:\bcall the [\w ]+ tool with\b|\binvoke [\w ]+\b|\buse the [\w ]+ server to send\b)`)},
			{"data_exfil_directive", "critical", 0.9,
				regexp.MustCompile(`(?i)(?:\b(?:send|forward|POST) .{0,80} to https?://\S+|\bexfiltrate\b|\bemail .{0,80} to \S+@\S+)`)},
			{"delimiter_break", "medium", 0.7,
				regexp.MustCompile(`(?i)(?:</system>|\[/INST\]|### assistant|` + "`" + `{3}\s*system)`)},
			{"encoded_payload_hint", "low", 0.5,
				regexp.MustCompile(`(?i)\b(?:run|execute|decode|eval|use)\s+[A-Za-z0-9+/=]{40,}`)},
		},
	}
}

func resolveInjectionConfig(cfg InjectionConfig) injectionRuntimeConfig {
	rt := injectionRuntimeConfig{
		Enabled:            true,
		BlockMinConfidence: cfg.BlockMinConfidence,
		ScanToolResults:    true,
	}
	if cfg.Enabled != nil {
		rt.Enabled = *cfg.Enabled
	}
	if cfg.ScanToolResults != nil {
		rt.ScanToolResults = *cfg.ScanToolResults
	}
	if rt.BlockMinConfidence <= 0 {
		rt.BlockMinConfidence = 0.8
	}
	return rt
}

// Classify scans content and returns findings tagged with source.
func (e *InjectionEngine) Classify(content, source string) []InjectionFinding {
	var out []InjectionFinding
	for _, r := range e.rules {
		matches := r.re.FindAllString(content, -1)
		if n := len(matches); n > 0 {
			out = append(out, InjectionFinding{
				Class: r.class, Source: source, Severity: r.severity,
				Confidence: r.conf, Count: n,
			})
		}
	}
	if n := countUnicodeTagRunes(content); n > 0 {
		out = append(out, InjectionFinding{
			Class: "unicode_tag_smuggle", Source: source, Severity: "critical",
			Confidence: 0.95, Count: n,
		})
	}
	return out
}

// Decide maps findings through the key's policy to an action.
// Returns the strongest applicable action: block > redact > flag > log > allow.
// Default (no policy): block high/critical findings with confidence >= BlockMinConfidence;
// flag the rest. encoded_payload_hint alone never blocks.
func (e *InjectionEngine) Decide(policyID string, findings []InjectionFinding) string {
	if len(findings) == 0 {
		return "allow"
	}
	best := "allow"
	for _, f := range findings {
		act := e.actionForFinding(policyID, f)
		if actionRank(act) > actionRank(best) {
			best = act
		}
	}
	if best == "block" && !e.mayBlock(findings) {
		return "flag"
	}
	return best
}

func (e *InjectionEngine) actionForFinding(policyID string, f InjectionFinding) string {
	if p, ok := e.policies[policyID]; ok && policyCovers(p, f) {
		return p.Action
	}
	if f.Class == "encoded_payload_hint" {
		return "flag"
	}
	if (f.Severity == "high" || f.Severity == "critical") && f.Confidence >= e.cfg.BlockMinConfidence {
		return "block"
	}
	return "flag"
}

func (e *InjectionEngine) mayBlock(findings []InjectionFinding) bool {
	hasBlockable := false
	for _, f := range findings {
		if f.Class == "encoded_payload_hint" {
			continue
		}
		if (f.Severity == "high" || f.Severity == "critical") && f.Confidence >= e.cfg.BlockMinConfidence {
			hasBlockable = true
		}
	}
	return hasBlockable
}

func policyCovers(p InjectionPolicy, f InjectionFinding) bool {
	if len(p.Classes) == 0 {
		return true
	}
	for _, c := range p.Classes {
		if c == f.Class {
			return true
		}
	}
	return false
}

func actionRank(a string) int {
	switch a {
	case "block":
		return 5
	case "redact":
		return 4
	case "flag":
		return 3
	case "log":
		return 2
	case "allow":
		return 1
	default:
		return 0
	}
}

// Redact replaces matched spans with category tokens, preserving structure.
func (e *InjectionEngine) Redact(content string) string {
	for _, r := range e.rules {
		content = r.re.ReplaceAllStringFunc(content, func(_ string) string {
			return "[BLOCKED:INJECTION:" + strings.ToUpper(r.class) + "]"
		})
	}
	content = redactUnicodeTags(content)
	return content
}

func countUnicodeTagRunes(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0xE0000 && r <= 0xE007F {
			n++
		}
	}
	return n
}

func redactUnicodeTags(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 0xE0000 && r <= 0xE007F {
			b.WriteString("[BLOCKED:INJECTION:UNICODE_TAG_SMUGGLE]")
			continue
		}
		if unicode.IsPrint(r) || r == '\n' || r == '\r' || r == '\t' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
