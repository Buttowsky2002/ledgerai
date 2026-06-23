package attribution

import "testing"

func TestResolveDeterministicSDKStamp(t *testing.T) {
	o := OutcomeRow{OutcomeID: "github:acme/web#42", TenantID: "t1", SourceSystem: "github"}
	runs := []RunRow{
		{RunID: "r-other", TenantID: "t1", AgentID: "a2"},
		{RunID: "r1", TenantID: "t1", AgentID: "a1", OutcomeID: "github:acme/web#42", TotalCostUSD: 8},
	}
	link, ok := ResolveDeterministic(o, runs, nil)
	if !ok {
		t.Fatal("expected a deterministic link from the SDK stamp")
	}
	if link.RunID != "r1" || link.AgentID != "a1" || link.Confidence != ConfSDKStamp {
		t.Fatalf("link = %+v, want r1/a1/conf 1.0", link)
	}
	if len(link.Evidence) != 1 || link.Evidence[0].Type != "sdk_session_link" ||
		link.Evidence[0].Ref != "https://github.com/acme/web/pull/42" {
		t.Fatalf("evidence = %+v, want sdk_session_link + PR URL", link.Evidence)
	}
}

func TestResolveDeterministicEvidenceNamesRun(t *testing.T) {
	o := OutcomeRow{OutcomeID: "jira:PROJ-12", TenantID: "t1", SourceSystem: "jira"}
	runs := []RunRow{{RunID: "r9", TenantID: "t1", AgentID: "a9"}}
	ev := []EvidenceRow{{
		TenantID: "t1", OutcomeID: "jira:PROJ-12", EvidenceType: "co_authored_by",
		RunID: "r9", Ref: "co-author: Claude <noreply@anthropic.com>",
	}}
	link, ok := ResolveDeterministic(o, runs, ev)
	if !ok {
		t.Fatal("expected a deterministic link from evidence naming a run")
	}
	if link.RunID != "r9" || link.AgentID != "a9" || link.Confidence != ConfHardEvidence {
		t.Fatalf("link = %+v, want r9/a9/conf 0.97", link)
	}
	if link.Evidence[0].Type != "co_authored_by" || link.Evidence[0].Ref == "" {
		t.Fatalf("evidence = %+v, want co_authored_by with a ref", link.Evidence)
	}
}

func TestResolveDeterministicEvidenceWithoutRunIsNotDeterministic(t *testing.T) {
	// A trailer that names only an agent (no session id) is NOT a hard link — it
	// must fall through to the probabilistic stages (precision 1.0 preserved).
	o := OutcomeRow{OutcomeID: "github:acme/web#7", TenantID: "t1", SourceSystem: "github"}
	ev := []EvidenceRow{{TenantID: "t1", OutcomeID: "github:acme/web#7", EvidenceType: "co_authored_by", AgentID: "a1"}}
	if _, ok := ResolveDeterministic(o, nil, ev); ok {
		t.Fatal("agent-only evidence must not produce a deterministic link")
	}
}

func TestResolveDeterministicNoLink(t *testing.T) {
	o := OutcomeRow{OutcomeID: "zendesk:99", TenantID: "t1", SourceSystem: "zendesk"}
	runs := []RunRow{{RunID: "r1", TenantID: "t1", OutcomeID: "github:other#1"}}
	if _, ok := ResolveDeterministic(o, runs, nil); ok {
		t.Fatal("expected no deterministic link")
	}
	if _, ok := ResolveDeterministic(OutcomeRow{}, runs, nil); ok {
		t.Fatal("empty outcome_id must not link")
	}
}

func TestDeriveOutcomeRef(t *testing.T) {
	cases := []struct{ id, src, want string }{
		{"github:acme/web#42", "github", "https://github.com/acme/web/pull/42"},
		{"github:acme/web", "github", "https://github.com/acme/web"},
		{"jira:PROJ-12", "jira", "PROJ-12"},
		{"zendesk:99", "zendesk", "99"},
		{"manual:abc", "manual", "abc"},
		{"nocolon", "github", "nocolon"},
	}
	for _, c := range cases {
		if got := deriveOutcomeRef(c.id, c.src); got != c.want {
			t.Errorf("deriveOutcomeRef(%q,%q) = %q, want %q", c.id, c.src, got, c.want)
		}
	}
}

// TestDeterministicPrecisionOnGolden is the 3.1 acceptance in unit form: the
// resolver fires ONLY on the SDK-stamped (deterministic) golden scenario, and
// every link it returns is a true positive — precision 1.0 by construction.
func TestDeterministicPrecisionOnGolden(t *testing.T) {
	pairs := GenerateGolden(2026, GoldenOptions{Scale: 3})
	resolved, truePos := 0, 0
	for _, p := range pairs {
		link, ok := ResolveDeterministic(p.Outcome, []RunRow{p.Run}, nil)
		if !ok {
			if p.Scenario == ScenarioDeterministic {
				t.Fatalf("deterministic scenario %s was not resolved", p.Run.RunID)
			}
			continue
		}
		resolved++
		if p.IsLinked && p.Scenario == ScenarioDeterministic && link.RunID == p.Run.RunID {
			truePos++
		}
	}
	if resolved == 0 {
		t.Fatal("resolver fired on nothing")
	}
	if truePos != resolved {
		t.Fatalf("precision = %d/%d, want 1.0 (resolver must never emit a false link)", truePos, resolved)
	}
}
