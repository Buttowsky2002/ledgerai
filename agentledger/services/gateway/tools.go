package main

// Inline tool/MCP governance (Phase 5 follow-up; ADR-032).
//
// The agent-native risk engine (ADR-027) compares observed tool/MCP calls
// against a per-agent, deny-by-default allowlist (Postgres agent_tool_allowlist,
// mirrored to ClickHouse agent_tool_allow). Until now that comparison was only
// ever made *after the fact* by the async risk-engine worker — a disallowed tool
// call still ran, and was merely scored as risk. This file moves the same
// allowlist to the inline path so the gateway, when it is in the request path,
// can refuse to even offer a disallowed tool/MCP server to the model.
//
// Enforcement model — "observe everywhere, enforce where configured":
//   - The async worker stays strict deny-by-default: any tool call lacking an
//     allow row is flagged, even for agents nobody has configured yet. That is
//     risk *scoring* and flagging everything unconfigured is correct.
//   - The gateway *blocks* inline only for agents that have at least one
//     allowlist entry — i.e. an operator has deliberately defined that agent's
//     tool surface. Within that scope it is deny-by-default: any declared tool
//     or MCP server not in the set is blocked. Agents with no entries (and
//     requests carrying no X-AgentLedger-Agent-Id) are never blocked here.
//
// This asymmetry is intentional (ADR-032): observation is free and safe, but
// inline blocking with strict deny-by-default would reject every tool-using
// request from every not-yet-configured agent the moment the gateway is
// deployed — violating "the gateway is optional, never break existing traffic"
// (CLAUDE.md §1). Populating an allowlist is the opt-in.
//
// All state lives in the atomically-swapped snapshot, so enforcement performs
// zero I/O on the request path (CLAUDE.md rule 12 / data-plane dependency
// minimalism).

// AgentToolAllowEntry is one row of the per-agent tool/MCP allowlist
// (Postgres agent_tool_allowlist). tool_name is required; mcp_server is the
// optional MCP server the tool belongs to. Tool names and MCP server names
// share one matching namespace (see ToolGovernor).
type AgentToolAllowEntry struct {
	TenantID  string `json:"tenant_id"`
	AgentID   string `json:"agent_id"`
	ToolName  string `json:"tool_name"`
	MCPServer string `json:"mcp_server,omitempty"`
}

// ToolGovernor enforces per-agent tool/MCP allowlists on the inline path. It is
// immutable once built and swapped atomically with the rest of the snapshot.
type ToolGovernor struct {
	// allow[tenantID][agentID] = set of allowed identifiers. Tool names and MCP
	// server names occupy the same namespace so a request declaring either is
	// checked against the union the operator allowed for that agent.
	allow map[string]map[string]map[string]struct{}
}

// NewToolGovernor builds a ToolGovernor from allowlist entries. Entries missing
// a tenant or agent are skipped (they cannot scope an enforcement decision).
func NewToolGovernor(entries []AgentToolAllowEntry) *ToolGovernor {
	g := &ToolGovernor{allow: make(map[string]map[string]map[string]struct{})}
	for _, e := range entries {
		if e.TenantID == "" || e.AgentID == "" {
			continue
		}
		byAgent := g.allow[e.TenantID]
		if byAgent == nil {
			byAgent = make(map[string]map[string]struct{})
			g.allow[e.TenantID] = byAgent
		}
		set := byAgent[e.AgentID]
		if set == nil {
			set = make(map[string]struct{})
			byAgent[e.AgentID] = set
		}
		if e.ToolName != "" {
			set[e.ToolName] = struct{}{}
		}
		if e.MCPServer != "" {
			set[e.MCPServer] = struct{}{}
		}
	}
	return g
}

// Governed reports whether (tenant, agent) has an allowlist and is therefore
// subject to inline deny-by-default enforcement.
func (g *ToolGovernor) Governed(tenantID, agentID string) bool {
	if g == nil || tenantID == "" || agentID == "" {
		return false
	}
	_, ok := g.allow[tenantID][agentID]
	return ok
}

// Disallowed returns the declared tool/MCP identifiers that are NOT permitted
// for the agent, preserving input order and de-duplicating. It returns nil when
// the agent is ungoverned (no allowlist) or when every declared identifier is
// allowed — so a nil/empty result always means "let the request through".
func (g *ToolGovernor) Disallowed(tenantID, agentID string, declared []string) []string {
	if !g.Governed(tenantID, agentID) {
		return nil
	}
	set := g.allow[tenantID][agentID]
	var bad []string
	seen := make(map[string]struct{})
	for _, d := range declared {
		if d == "" {
			continue
		}
		if _, ok := set[d]; ok {
			continue
		}
		if _, dup := seen[d]; dup {
			continue
		}
		seen[d] = struct{}{}
		bad = append(bad, d)
	}
	return bad
}
