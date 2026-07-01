# FOCUS 1.2 export — column mapping

BadgerIQ exports cost data in the [FinOps Open Cost & Usage Specification
(FOCUS) 1.2](https://focus.finops.org/) so a customer's FinOps team can fold AI
spend into the same tooling as their cloud bills. The export is **generated on
demand** from the ClickHouse `spend_daily` materialized view (per day × team ×
app × provider × model) via `GET /v1/analytics/focus-export` — it is never
persisted, and per CLAUDE.md rule 2 it carries **cost/usage/attribution
dimensions only**, never prompt/completion content.

`focus-1.2.columns.json` is the canonical column set and **CSV column order**.
Each row is one (day, team, app, provider, model) charge.

## Mapping (spend_daily → FOCUS)

| FOCUS column | Source |
|---|---|
| `BillingAccountId` | `tenant_id` (from the request principal) |
| `BillingCurrency` | constant `USD` |
| `BillingPeriodStart` / `BillingPeriodEnd` | the requested `from` / `to` window |
| `ChargePeriodStart` / `ChargePeriodEnd` | `day` / `day + 1d` |
| `ChargeCategory` | constant `Usage` |
| `ChargeDescription` | `"<provider> <model> usage"` |
| `BilledCost` / `EffectiveCost` / `ListCost` | `cost_usd` (BadgerIQ has no negotiated-rate distinction today, so all three are equal) |
| `ProviderName` / `PublisherName` | `provider` |
| `ServiceName` | `model` |
| `ServiceCategory` | constant `AI and Machine Learning` |
| `ResourceId` | `app_id` |
| `ResourceType` | constant `AI Application` |

## `x_ai_*` extensions

FOCUS reserves the `x_<...>` prefix for provider extensions. BadgerIQ adds AI-native
dimensions so spend stays sliceable by model/team/tokens after import:

`x_ai_provider`, `x_ai_model`, `x_ai_team_id`, `x_ai_app_id`,
`x_ai_input_tokens`, `x_ai_output_tokens`, `x_ai_cached_tokens`, `x_ai_calls`.

## Notes

- **Tenant isolation:** the export query is `queryScoped` — `tenant_id` is bound
  from the JWT principal, never request input (rule 3); ClickHouse has no RLS.
- **Agent-grain:** `spend_daily` is aggregated above the agent, so `x_ai_agent_id`
  is intentionally absent from this export; agent-level FOCUS lines can be added
  later from `spend_hourly_by_key` under a new ADR if a customer needs them.
- **Versioning:** bump `version` in the JSON and add an ADR if the FOCUS column set
  changes — downstream importers pin to it.
