package chinsert

// ClickHouse target tables. These are compile-time constants, never derived
// from event data — table identifiers cannot be query-parameterized, so a
// fixed allowlist is how we keep inserts injection-safe (CLAUDE.md rule 4).
const (
	TableLLMCalls       = "llm_calls"
	TableAgentRuns      = "agent_runs"
	TableOutcomes       = "outcomes"
	TableAgentToolCalls = "agent_tool_calls"
)

type routeDecision int

const (
	routeInsert     routeDecision = iota // insert into the returned table
	routeSkip                            // valid event with no direct table
	routeDeadLetter                      // unknown/unroutable — poison
)

// route maps an event kind to a ClickHouse table and a handling decision.
// An absent kind is treated as llm_call (the gateway emits no kind).
func route(kind string) (table string, d routeDecision) {
	switch kind {
	case "", "llm_call":
		return TableLLMCalls, routeInsert
	case "agent_run":
		return TableAgentRuns, routeInsert
	case "outcome":
		return TableOutcomes, routeInsert
	case "tool_call":
		// Observed tool/MCP invocations feed the agent-native risk engine
		// (deny-by-default allowlist comparison). tool_call_id is the
		// ReplacingMergeTree dedup key, enforced at the validation boundary.
		return TableAgentToolCalls, routeInsert
	default:
		return "", routeDeadLetter
	}
}

// isKnownTable guards the inserter against any table value that did not come
// from route() — defense in depth for the injection-safety invariant.
func isKnownTable(table string) bool {
	switch table {
	case TableLLMCalls, TableAgentRuns, TableOutcomes, TableAgentToolCalls:
		return true
	default:
		return false
	}
}
