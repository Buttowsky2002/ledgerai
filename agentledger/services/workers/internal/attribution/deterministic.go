package attribution

import (
	"fmt"
	"strings"
)

// Deterministic layer (build-plan sub-phase 3.1). Hard links — facts, not
// estimates — produce method=deterministic edges at fixed high confidence and
// SKIP the probabilistic stages. They are also the ground-truth LABELS the
// probabilistic scorer (3.3) and calibration train on — the build plan's elegant
// seam (§1, §4 step 2): every agent-stamped link is a labeled positive, so the
// engine self-improves from real data with no manual labeling.
//
// Precision on the deterministic set is 1.0 BY CONSTRUCTION: an edge is emitted
// only when a concrete run↔outcome link exists (an SDK/agent assertion or a
// connector-discovered hard link that names the run). Anything weaker falls
// through to the probabilistic stages.
//
// SECURITY: evidence is a structural REFERENCE (PR/issue URL, session id, trailer
// identity, linked ticket id) — never copied PR/commit/issue body or
// prompt/completion content (CLAUDE.md rule 2; build-plan §7 — evidence not payloads).

// Deterministic confidence by link strength. An SDK-asserted run→outcome link is
// the strongest possible signal (1.0 — matches the V1 matcher and ADR-024); a
// connector-discovered hard link (Co-Authored-By trailer with a session id, a
// session-id stamp in merged metadata, an agent-API close) is near-certain (0.97).
const (
	ConfSDKStamp     = 1.0
	ConfHardEvidence = 0.97
)

// DeterministicEvidence is one structural reason a link is certain.
type DeterministicEvidence struct {
	Type    string `json:"type"`               // sdk_session_link | co_authored_by | api_close
	RunID   string `json:"run_id,omitempty"`   //
	AgentID string `json:"agent_id,omitempty"` //
	Ref     string `json:"ref,omitempty"`      // PR/issue URL, session id, trailer identity, ticket id
}

// DeterministicLink is a resolved hard link from an outcome to the run that
// produced it, with the evidence behind it.
type DeterministicLink struct {
	OutcomeID  string
	RunID      string
	AgentID    string
	Confidence float64
	Evidence   []DeterministicEvidence
}

// ResolveDeterministic returns the hard link for an outcome, if one exists, from
// (a) an SDK/agent-API stamp (run.outcome_id == outcome.outcome_id) and (b)
// connector-discovered evidence that concretely names a run. ok=false means no
// deterministic link — the candidate falls through to the probabilistic stages
// (3.3). The SDK stamp wins when both are present (it is the stronger assertion).
func ResolveDeterministic(o OutcomeRow, runs []RunRow, evidence []EvidenceRow) (DeterministicLink, bool) {
	if o.OutcomeID == "" {
		return DeterministicLink{}, false
	}
	ref := deriveOutcomeRef(o.OutcomeID, o.SourceSystem)

	// (a) SDK / agent-API stamp: the run itself asserts it produced this outcome.
	for _, r := range runs {
		if r.OutcomeID != "" && r.OutcomeID == o.OutcomeID {
			return DeterministicLink{
				OutcomeID:  o.OutcomeID,
				RunID:      r.RunID,
				AgentID:    r.AgentID,
				Confidence: ConfSDKStamp,
				Evidence: []DeterministicEvidence{{
					Type: "sdk_session_link", RunID: r.RunID, AgentID: r.AgentID, Ref: ref,
				}},
			}, true
		}
	}

	// (b) Connector-discovered hard link that concretely names a run (a
	// Co-Authored-By trailer carrying the session id, an agent-API close). An
	// agent-only trailer with no run is NOT deterministic — it is left to 3.3.
	for _, ev := range evidence {
		if ev.OutcomeID != o.OutcomeID || ev.RunID == "" {
			continue
		}
		agentID := ev.AgentID
		if agentID == "" {
			agentID = agentForRun(runs, ev.RunID)
		}
		evRef := ev.Ref
		if evRef == "" {
			evRef = ref
		}
		return DeterministicLink{
			OutcomeID:  o.OutcomeID,
			RunID:      ev.RunID,
			AgentID:    agentID,
			Confidence: ConfHardEvidence,
			Evidence: []DeterministicEvidence{{
				Type: ev.EvidenceType, RunID: ev.RunID, AgentID: agentID, Ref: evRef,
			}},
		}, true
	}

	return DeterministicLink{}, false
}

func agentForRun(runs []RunRow, runID string) string {
	for _, r := range runs {
		if r.RunID == runID {
			return r.AgentID
		}
	}
	return ""
}

// deriveOutcomeRef turns a stable outcome_id into a human-traceable structural
// reference for the audit UI — a URL where the source supports one, the bare key
// otherwise. Pure string derivation from the id connectors already mint; no
// network call, no content (rule 2).
func deriveOutcomeRef(outcomeID, sourceSystem string) string {
	i := strings.IndexByte(outcomeID, ':')
	if i < 0 || i == len(outcomeID)-1 {
		return outcomeID
	}
	key := outcomeID[i+1:]
	if sourceSystem == "github" {
		// owner/repo#42 → https://github.com/owner/repo/pull/42
		if h := strings.LastIndexByte(key, '#'); h > 0 && h < len(key)-1 {
			return fmt.Sprintf("https://github.com/%s/pull/%s", key[:h], key[h+1:])
		}
		return "https://github.com/" + key
	}
	// jira:PROJ-12 → PROJ-12 ; zendesk:99 → 99 ; manual/api → the bare key.
	return key
}
