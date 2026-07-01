# BadgerIQ

**AI FinOps control plane** — spend attribution, agent unit economics, prompt risk, and risk-adjusted ROI in one system of record. Built from `AI_FinOps_Product_Requirements_and_Market_Research.docx`; architecture rationale in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What's in this repo

| Path | What it is | Status |
|---|---|---|
| `services/gateway/` | OpenAI-compatible Go gateway: virtual keys, budgets, rate limits, DLP (redact/block), streaming usage capture, effective-dated cost engine, async canonical events | ✅ compiled, 8 unit tests + live smoke test passing |
| `deploy/clickhouse/001_events.sql` | Analytics plane: `llm_calls`, `agent_runs`, `outcomes` + incremental materialized views (daily spend, hourly budget burn, risk rollup, unit economics) | ✅ ready to apply |
| `deploy/postgres/001_core.sql` | Control plane: tenants, identity graph, app/agent registry, virtual keys, policies, price book, allocation rules, budgets, connectors, ROI templates, audit log | ✅ ready to apply |
| `packages/sdk-python/` | Stdlib-only tracing SDK: agent runs, steps, tool calls, business outcomes (OTel GenAI-aligned attributes) | ✅ verified e2e against mock collector |
| `pricing/pricebook.json` | Effective-dated price book seed (verify rates before production) | ✅ |
| `docker-compose.yml` | Local stack: Postgres + ClickHouse + Redpanda + gateway | ✅ |

## Quickstart

**Just want to see it?** `make demo` brings up the backend, seeds a demo tenant,
and prints how to start the dashboard — **no provider keys required**. Full
deployment guide (demo · gateway-dev · production): [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md);
variable reference: [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md).

```bash
# run the test suite
make test

# build and run the gateway against real providers
cd services/gateway
cp config.example.json config.json        # edit virtual keys / policies
export OPENAI_API_KEY=sk-...              # upstream provider keys
go run . &

# call it like OpenAI — attribution, budget, DLP, and cost happen inline
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer <your-virtual-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'

# or call it like Anthropic — same governance, Messages API in and out
curl http://localhost:8080/v1/messages \
  -H "Authorization: Bearer <your-virtual-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":256,"messages":[{"role":"user","content":"hello"}]}'

# canonical events (one JSON line per call, ClickHouse JSONEachRow-ready)
tail -f events.ndjson
```

Or bring up the full local stack: `docker compose up -d`.

## Verified behavior (smoke test)

A request containing an AWS access key and a Luhn-valid card number, sent through the gateway with a `redact` policy:

- upstream provider received `debug key [REDACTED:AWS_ACCESS_KEY] and card [REDACTED:CREDIT_CARD]` — raw secrets never left the perimeter
- exact cost computed from the price book including cached-token pricing (`$0.00725` for 1,000 in / 200 cached / 500 out on gpt-4o)
- budget reserved before the call (a conservative estimate) and committed to the actual cost afterward; the over-budget second call is rejected pre-flight with HTTP 402
- canonical event emitted with full attribution (tenant/team/user/app/agent/run), `dlp_action=redact`, `risk_severity=critical`

Run it yourself: `python3 services/gateway/smoke_test.py`

## Design principles

1. **Thin inline path** — auth, budget reservation, and deterministic DLP run on the hot path (in-memory by default, or a single atomic Redis round-trip across replicas); classification, enrichment, ROI matching, and aggregation are async behind the event bus.
2. **Privacy by structure** — the canonical event has no raw-content field; prompt hash + categorical findings only. Full capture is a separate opt-in encrypted path.
3. **Standards over invention** — FOCUS 1.2 (+ `x_ai_*` extensions) for cost export, OTel GenAI semantic conventions for telemetry, ClickHouse MV patterns proven at 50M+ events/day.
4. **Own the correlation layer** — gateway, activity graph, ROI engine, and policy decisioning are proprietary; everything else integrates.

## Budget enforcement

The gateway holds budget with a **reserve → commit/release** lifecycle:

- **Reserve** (before the upstream call) checks the monthly cap and per-minute
  rate limit and immediately holds a conservative estimate — priced from the
  request's `max_tokens`, or `BADGERIQ_DEFAULT_RESERVE_USD` when it is absent.
- **Commit** adjusts the hold to the realized cost once usage is known.
- **Release** returns the hold when the call fails before any billable usage.

The check and the hold are atomic — under a mutex in the in-memory store, and via
a Lua script in the Redis store — so enforcement is concurrency-safe. The cap is
**soft by one reservation**: concurrent in-flight requests can exceed the monthly
budget by at most a single reservation, never more. This is a deliberate tradeoff
for a zero-extra-latency inline path; exact accounting is reconciled against
provider billing downstream.

On a Redis backend error, `BADGERIQ_BUDGET_FAIL_MODE` selects behavior:
`open` (default) keeps serving; `closed` rejects with HTTP 503.

## Renaming to BadgerIQ

This project was previously named **AgentLedger / AgentLedger AI** and **LedgerAI**.
The current product name is **BadgerIQ**. The transition is backwards-compatible:

- **Environment variables** — prefer the new `BADGERIQ_*` prefix. Every service
  reads the new name first and falls back to `LEDGERAI_*` and the legacy
  `AGENTLEDGER_*` names, so existing deployments keep working. The older prefixes
  are deprecated aliases (e.g. `AGENTLEDGER_PG_DSN` → `BADGERIQ_PG_DSN`).
- **Wire/import identifiers are intentionally unchanged** — request headers
  (`X-AgentLedger-*`), SDK package names (`@agentledger/*`, the Python
  `agentledger` package), database tables, and the event schema are client
  contracts and are not renamed here.
