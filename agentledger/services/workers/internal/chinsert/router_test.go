package chinsert

import "testing"

func TestRoute(t *testing.T) {
	cases := []struct {
		kind  string
		table string
		dec   routeDecision
	}{
		{"", TableLLMCalls, routeInsert}, // gateway events carry no kind
		{"llm_call", TableLLMCalls, routeInsert},
		{"agent_run", TableAgentRuns, routeInsert},
		{"outcome", TableOutcomes, routeInsert},
		{"tool_call", "", routeSkip},
		{"banana", "", routeDeadLetter},
	}
	for _, c := range cases {
		table, dec := route(c.kind)
		if table != c.table || dec != c.dec {
			t.Errorf("route(%q) = (%q,%d), want (%q,%d)", c.kind, table, dec, c.table, c.dec)
		}
	}
}

func TestIsKnownTable(t *testing.T) {
	for _, ok := range []string{TableLLMCalls, TableAgentRuns, TableOutcomes} {
		if !isKnownTable(ok) {
			t.Errorf("%q should be known", ok)
		}
	}
	for _, bad := range []string{"", "users; DROP TABLE x", "llm_calls; --"} {
		if isKnownTable(bad) {
			t.Errorf("%q must not be a known table", bad)
		}
	}
}
