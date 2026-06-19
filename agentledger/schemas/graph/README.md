# Agent Outcome Graph — schema

`outcome_graph.schema.json` is the **formal contract** for AgentLedger's Agent
Outcome Graph (CLAUDE.md Phase 3 — "the moat"): the graph that makes
`cost → agent → outcome → value` queryable with an **attribution confidence on
every edge**. This directory is the abstract definition; the graph is physically
realized across Postgres (control plane) and ClickHouse (analytics).

## Nodes

| Graph node | `identity_type` / role | Physical source |
|------------|------------------------|-----------------|
| `identity` (human) | `human` | Postgres `identities` |
| `identity` (agent / **NHI**) | `agent` | Postgres `agents` |
| `agent_run` | — | ClickHouse `agent_runs` |
| `outcome` | — | ClickHouse `outcomes` |

Humans and agents are unified as first-class identities through the Postgres
view **`v_identities`** (`identity_type` ∈ {`human`,`agent`}), so a
non-human identity (an agent) is a node alongside its human owner rather than a
bare `agent_id` string. `v_identities` is `security_invoker` so tenant RLS
applies as the querying role.

## Edges (every edge carries `attribution_confidence` ∈ [0,1])

| Edge | From → To | Confidence |
|------|-----------|------------|
| `operates` | identity(human) → identity(agent) | `1.0` (registry: `agents.owner_user_id`) |
| `performed_by` | agent_run → identity(human) | `1.0` (`agent_runs.user_id`) |
| `incurred_cost` | agent_run → cost | `1.0` (`agent_runs.total_cost_usd`, summed `llm_calls`) |
| `produced` | agent_run → outcome | **matcher score** (`outcomes.attribution_confidence`) |
| `valued_at` | outcome → business value | `1.0` (`outcomes.business_value_usd`) |

The only probabilistic edge is `produced`: the attribution matcher
(`services/workers/internal/attribution`) correlates an outcome to the agent run
that produced it on time-window + identity + branch/issue/ticket reference, and
writes the score to `outcomes.attribution_confidence` (`1.0` for SDK/agent-stamped
direct links; `<1.0` for probabilistic links). All other edges are structural and
deterministic.

## Querying the graph

- **`v_outcome_graph`** (ClickHouse) — the end-to-end trace: one row per outcome
  joining `outcomes → agent_runs` exposing `ai_cost_usd`, `agent_id`,
  `business_value_usd`, `net_value_usd`, and the `attribution_confidence` of the
  `produced` edge, plus `headline_eligible` (confidence ≥ 0.5).
- **`v_unit_economics`** (ClickHouse) — the cost-per-outcome aggregate
  (cost/value per month/outcome_type/team).
- **Headline low-confidence exclusion** (Phase 3 acceptance) is enforced at the
  API/UI layer, not in a view: `/v1/analytics/unit-economics` takes a
  `minConfidence` param and the dashboard's headline defaults it to **0.5**
  (showing the unfiltered count as a baseline), so weak/probabilistic
  attributions never inflate headline ROI.

## Realizing migrations / code

- Postgres: `deploy/postgres/005_identities_view.sql` (`v_identities`).
- ClickHouse: `deploy/clickhouse/005_outcome_graph.sql` (`v_outcome_graph`);
  base tables + `v_unit_economics` in `001_events.sql`.
- Matcher: `services/workers/internal/attribution`.
- Outcome connectors: `services/connectors/internal/connector` (github, jira,
  zendesk; CRM deferred — see `docs/ADRs/025-crm-connector-deferral.md`).
