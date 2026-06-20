package main

import (
	"regexp"
	"strings"
)

// DLPEngine implements the MVP classification strategy from the PRD:
// deterministic classifiers first (fast, explainable, no raw-prompt
// storage required), ML classifiers later as async enrichment.
//
// The inline path only ever sees the request body transiently; the
// emitted event carries category/severity/action — never raw content.

// Finding is a single DLP classifier hit; it carries class/category/severity
// metadata but never the raw matched content.
type Finding struct {
	Class      string  `json:"class"`    // e.g. "aws_access_key"
	Category   string  `json:"category"` // credentials | pii | pci | source_code
	Severity   string  `json:"severity"` // low | medium | high | critical
	Confidence float64 `json:"confidence"`
	Count      int     `json:"count"`
}

type classifier struct {
	class    string
	category string
	severity string
	conf     float64
	re       *regexp.Regexp
	validate func(string) bool // optional secondary validation (e.g. Luhn)
}

// DLPEngine applies deterministic classifier rules and per-policy actions to
// request bodies on the inline path.
type DLPEngine struct {
	cfg         DLPConfig
	classifiers []classifier
	policies    map[string]DLPPolicy
}

// NewDLPEngine builds a DLPEngine from the given config, indexing policies by ID.
func NewDLPEngine(cfg DLPConfig) *DLPEngine {
	pol := map[string]DLPPolicy{}
	for _, p := range cfg.Policies {
		pol[p.ID] = p
	}
	return &DLPEngine{
		cfg:      cfg,
		policies: pol,
		classifiers: []classifier{
			{"aws_access_key", "credentials", "critical", 0.98,
				regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`), nil},
			{"private_key_block", "credentials", "critical", 0.99,
				regexp.MustCompile(`-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----`), nil},
			{"generic_api_key", "credentials", "high", 0.7,
				regexp.MustCompile(`\b(?:sk|pk|api|key|token)[-_](?:live|test|prod)?[-_]?[A-Za-z0-9]{20,}\b`), nil},
			{"jwt", "credentials", "high", 0.9,
				regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`), nil},
			{"credit_card", "pci", "critical", 0.85,
				regexp.MustCompile(`\b(?:\d[ -]?){13,19}\b`), luhnValid},
			{"us_ssn", "pii", "high", 0.8,
				regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`), nil},
			{"email_address", "pii", "low", 0.95,
				regexp.MustCompile(`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`), nil},
			{"ipv4_address", "pii", "low", 0.6,
				regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`), nil},
		},
	}
}

// Classify scans content and returns findings.
func (d *DLPEngine) Classify(content string) []Finding {
	var out []Finding
	for _, c := range d.classifiers {
		matches := c.re.FindAllString(content, -1)
		n := 0
		for _, m := range matches {
			if c.validate == nil || c.validate(m) {
				n++
			}
		}
		if n > 0 {
			out = append(out, Finding{
				Class: c.class, Category: c.category, Severity: c.severity,
				Confidence: c.conf, Count: n,
			})
		}
	}
	return out
}

// Decide maps findings through the key's policy to an action.
// Returns the strongest applicable action: block > redact > warn > log > allow.
func (d *DLPEngine) Decide(policyID string, findings []Finding) string {
	if len(findings) == 0 {
		return "allow"
	}
	p, ok := d.policies[policyID]
	if !ok {
		// no policy configured: log only (audit-mode default per PRD)
		return "log"
	}
	covered := func(f Finding) bool {
		if len(p.Classes) == 0 {
			return true
		}
		for _, c := range p.Classes {
			if c == f.Class || c == f.Category {
				return true
			}
		}
		return false
	}
	for _, f := range findings {
		if covered(f) {
			return p.Action
		}
	}
	return "log"
}

// Redact replaces matched spans with category tokens, preserving structure.
func (d *DLPEngine) Redact(content string) string {
	for _, c := range d.classifiers {
		content = c.re.ReplaceAllStringFunc(content, func(m string) string {
			if c.validate != nil && !c.validate(m) {
				return m
			}
			return "[REDACTED:" + strings.ToUpper(c.class) + "]"
		})
	}
	return content
}

// luhnValid checks credit-card candidates to suppress false positives
// on phone numbers, IDs, and timestamps.
func luhnValid(s string) bool {
	var digits []int
	for _, r := range s {
		if r >= '0' && r <= '9' {
			digits = append(digits, int(r-'0'))
		}
	}
	if len(digits) < 13 || len(digits) > 19 {
		return false
	}
	sum, alt := 0, false
	for i := len(digits) - 1; i >= 0; i-- {
		d := digits[i]
		if alt {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		alt = !alt
	}
	return sum%10 == 0
}
