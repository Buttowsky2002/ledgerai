# BadgerIQ

**AI FinOps control plane** — spend attribution, agent unit economics, prompt risk, and risk-adjusted ROI in one system of record. Application code lives under [`agentledger/`](agentledger/). Architecture rationale: [`agentledger/docs/ARCHITECTURE.md`](agentledger/docs/ARCHITECTURE.md).

## What's in this repo

| Path | What it is | Status |
|---|---|---|
| `agentledger/services/gateway/` | OpenAI-compatible Go gateway: virtual keys, budgets, rate limits, DLP (redact/block), streaming usage capture, effective-dated cost engine, async canonical events | ✅ compiled, 8 unit tests + live smoke test passing |
| `agentledger/deploy/clickhouse/001_events.sql` | Analytics plane: `llm_calls`, `agent_runs`, `outcomes` + incremental materialized views | ✅ ready to apply |
| `agentledger/deploy/postgres/001_core.sql` | Control plane: tenants, identity graph, app/agent registry, virtual keys, policies, price book, budgets, connectors, audit log | ✅ ready to apply |
| `agentledger/packages/sdk-python/` | Stdlib-only tracing SDK: agent runs, steps, tool calls, business outcomes | ✅ verified e2e against mock collector |
| `agentledger/pricing/pricebook.json` | Effective-dated price book seed (verify rates before production) | ✅ |
| `agentledger/docker-compose.yml` | Local stack: Postgres + ClickHouse + Redpanda + gateway + API + dashboard | ✅ |

## Quickstart

```bash
cd agentledger

# run the test suite
make test

# demo mode — no provider keys required
make demo
```

Full deployment guide: [`agentledger/docs/DEPLOYMENT.md`](agentledger/docs/DEPLOYMENT.md).  
Variable reference: [`agentledger/docs/ENVIRONMENT.md`](agentledger/docs/ENVIRONMENT.md).

## Security

Found a vulnerability? Please report it privately — see [`SECURITY.md`](SECURITY.md)
for the disclosure process, response SLA, and safe-harbor terms. **Do not open a
public issue for security reports.** Operators forking or deploying BadgerIQ must set
a real security contact in `SECURITY.md` before production.

## Renaming to BadgerIQ

This project was previously named **AgentLedger / AgentLedger AI** and **LedgerAI**.
The current product name is **BadgerIQ**. The transition is backwards-compatible:

- **Environment variables** — prefer the new `BADGERIQ_*` prefix. Every service
  reads the new name first and falls back to `LEDGERAI_*` and the legacy
  `AGENTLEDGER_*` names, so existing deployments keep working. The older prefixes
  are deprecated aliases (e.g. `AGENTLEDGER_PG_DSN` → `BADGERIQ_PG_DSN`).
- **Package/module names** use the `@badgeriq/*` npm scope and the
  `github.com/badgeriq/*` Go module paths.
- **Wire identifiers are intentionally unchanged** — request headers
  (`X-AgentLedger-*`), the Python `agentledger` package, database/schema
  names, and the event schema are client contracts and are not renamed here.

See [`agentledger/README.md`](agentledger/README.md) for the full developer guide.
