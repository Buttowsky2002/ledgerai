# CLAUDE.md — BadgerIQ AI Build Specification
<!--
HOW TO USE THIS FILE:
1. Create a new git repository.
2. Unzip agentledger.zip into the repo root (its contents become the seed code).
3. Place this file at the repo root as CLAUDE.md.
4. Also copy docs/ARCHITECTURE.md and docs/ARCHITECTURE_PIVOT.md from the package — Claude Code reads both before any phase.
5. Open Claude Code in the repo and say: "Read CLAUDE.md, ARCHITECTURE.md, and ARCHITECTURE_PIVOT.md, then begin Phase 1."
This file is binding standing instructions for the whole project. Where ARCHITECTURE.md (original) and ARCHITECTURE_PIVOT.md differ, THE PIVOT WINS — this spec already reflects it.
-->

## 1. Project Context & Positioning

You are building **BadgerIQ AI**, the **agent FinOps & risk control plane**. It sits on top of whatever AI stack a customer already runs and answers the question no competitor productizes: **what is each AI agent costing, returning, and risking?**

This is a deliberate pivot away from "an AI gateway with cost tracking and DLP." The market is saturated with AI gateways (Bifrost, LiteLLM, Portkey) and LLM observability (Langfuse, Helicone, LangSmith). BadgerIQ does **not** compete with them on their turf — it **consumes** them as data sources and adds the layer none of them have: the **Agent Outcome Graph** and **risk-adjusted ROI**. The buyer is the **finance/FinOps lead and the CISO**, not the platform engineer.

Three consequences govern every decision:
- **The gateway is optional, not the center.** It is the premium enforcement tier. Most customers will onboard by connecting an existing source. Never assume traffic flows through our gateway.
- **The Agent Outcome Graph is the core asset.** `identity → agent → run → (llm_calls + tool_calls + mcp_calls) → outcome → value`, with `attribution_confidence` on every edge. The ROI engine and the risk engine both read from it.
- **Risk is a dimension of FinOps, not a separate product.** We surface agent-native risk (tool/MCP governance, injection, non-human identity) and fold it into risk-adjusted ROI. We do not try to become a standalone security product or a browser/endpoint DLP.

A **working data-plane seed already exists in this repository** — extend it, do not rewrite it:
- `services/gateway/` — Go 1.22, stdlib-only, OpenAI-compatible gateway. Virtual-key auth, budgets, rate limits, deterministic DLP (redact/block), streaming with usage capture, cache-aware cost, async event emission. 8 passing tests + `smoke_test.py`. **Repositioned as the optional enforcement tier.**
- `deploy/postgres/001_core.sql` — control-plane schema (tenants, identities, agents, virtual keys as hashes, policies, price book, budgets, audit log).
- `deploy/clickhouse/001_events.sql` — `llm_calls` + SummingMergeTree MVs + `v_unit_economics`.
- `packages/sdk-python/` — stdlib-only tracing SDK (run/step/outcome, fire-and-forget, never raises).
- `pricing/pricebook.json`, `docker-compose.yml`, `Makefile`.

**Read `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE_PIVOT.md` in full before any code.** Binding decisions: FOCUS 1.2 as the canonical/export schema (with `x_ai_*` extensions), OTel GenAI semantic conventions in telemetry, ClickHouse + incremental MVs for analytics, Go for the data plane / TypeScript for the control plane, and the governing rule that **the gateway inline path performs zero I/O** — anything heavy is async behind the event bus.

## 2. Target Repository Structure

Evolve toward this layout; create directories as their phase begins. The shift from the original tree: ingestion is now a first-class multi-source front door, and the outcome graph + risk engine are explicit.

```
agentledger/
├── CLAUDE.md
├── README.md  Makefile  docker-compose.yml
├── .github/workflows/      # ci.yml (lint+test+SAST+secret-scan+dep-audit) , release.yml (SBOM+sign)
├── docs/
│   ├── ARCHITECTURE.md  ARCHITECTURE_PIVOT.md
│   ├── ADRs/  RUNBOOKS/  api/
├── services/
│   ├── gateway/            # EXISTING — optional enforcement tier (Go). Extend, don't rewrite.
│   ├── ingest/             # P1 — the front door. Multi-source intake → Redpanda `events.raw`.
│   │   ├── collector/      #   native SDK/OTel HTTP ingest (validates vs schemas/events/)
│   │   └── adapters/       #   normalizers that turn 3rd-party sources into canonical events:
│   │       ├── litellm/  bifrost/  portkey/  openrouter/   # parse their spend/usage logs
│   │       └── otel-genai/                                 # accept gen_ai.* spans
│   ├── workers/            # P1+ — Go async consumers, one cmd per worker:
│   │   ├── ch-insert/  reconciliation/  attribution-matcher/
│   │   └── risk-enrichment/  anomaly/
│   ├── connectors/         # P2/P3 — Go importers (cursor-based incremental sync):
│   │   ├── openai-usage/  anthropic-usage/  bedrock/  vertex/   # P2 provider billing
│   │   └── github/  jira/  zendesk/  crm/                       # P3 business outcomes
│   └── api/                # P4 — NestJS control plane: graph queries, ROI, governance, CRUD
├── apps/
│   └── dashboard/          # P4 — Next.js: CFO view, CISO view, agent detail, budgets, risk
├── packages/
│   ├── sdk-python/         # EXISTING — make OTel-native; outcome+agent context is the star
│   ├── sdk-typescript/     # P3 — mirror (agent customers are often TS)
│   └── shared-types/       # generated from OpenAPI + event JSON Schema
├── schemas/
│   ├── events/llm_call.schema.json     # canonical event — single source of truth
│   ├── graph/                          # outcome-graph schema: identities(incl. NHI), outcomes, edges, confidence
│   └── focus/                          # FOCUS 1.2 mapping + x_ai_* extension spec
├── deploy/
│   ├── postgres/  clickhouse/          # numbered, forward-only migrations
│   └── helm/  terraform/               # P6
├── pricing/pricebook.json
└── tests/  e2e/  load/
```

Conventions: Go services use `cmd/` + `internal/` once past one package. DB changes are numbered, forward-only migrations — never edit an applied one. The event JSON Schema and the graph schema in `schemas/` are the contracts between producers and consumers; version them deliberately.

## 3. Build Phases (work in order; each has acceptance criteria)

### Phase 1 — Gateway hardening **and gateway-agnostic ingestion** (≈ weeks 1–3)
The pivot's first job is "connect a source, see value" — without requiring our gateway.
1. **Collector** (`services/ingest/collector/`): HTTP intake for SDK + OTel GenAI events, validates against `schemas/events/`, writes to Redpanda `events.raw`, returns 202, backpressure → 429, never blocks.
2. **At least two ingestion adapters** (`services/ingest/adapters/`): a LiteLLM (or Bifrost) spend-log normalizer, and the OTel GenAI span endpoint, each mapping to the canonical event. This is what turns competitors into data sources.
3. **CH-insert worker** (`services/workers/ch-insert/`): consumes `events.raw`, batched JSONEachRow inserts, dead-letters poison messages.
4. **Gateway hardening** (carried from original P1): Redis budget store behind the existing `BudgetStore` interface; config hot-reload via atomic snapshot swap serving last-known-good on control-plane outage; Anthropic-native `/v1/messages` translation with streaming + cache tokens.
- **Accept when**: `make test` green; an e2e test proves a 3rd-party source (LiteLLM log sample OR an OTel span) → collector/adapter → Redpanda → ClickHouse row with correct cost + attribution dims; the gateway path still works but nothing requires it; budget survives gateway restart.

### Phase 2 — Provider billing connectors + reconciliation (≈ weeks 4–6)
Connector framework (cursor-based incremental sync, per-connector rate limiting, retry w/ jitter, state in Postgres `connectors`). Importers: OpenAI, Anthropic, Bedrock, Vertex usage+cost. Reconciliation worker diffs observed vs billed cost per day/model/key, books adjustments, flags drift > 2%.
- **Accept when**: connectors replay from cursor after crash with no duplicates (ReplacingMergeTree dedup verified); per-day drift report query returns.

### Phase 3 — **The Agent Outcome Graph** + outcome connectors (≈ weeks 7–10) — THE MOAT, built early
1. **Graph schema** (`schemas/graph/`, Postgres + ClickHouse): identities as first-class incl. **non-human identities (NHIs)** for agents; outcomes; edges with `attribution_confidence`.
2. **Outcome connectors** (`services/connectors/github|jira|zendesk|crm/`): import merged PRs, closed issues, resolved tickets, qualified leads.
3. **Attribution matcher** (`services/workers/attribution-matcher/`): correlates outcomes to agent runs on time-window + identity + branch/issue/ticket reference; emits confidence. Deterministic, high-confidence links (agent-stamped commit/PR) first; probabilistic links clearly flagged.
- **Accept when**: `cost → agent → outcome → value` is queryable with a confidence on every edge; a seeded demo shows a high-confidence outcome (e.g., agent-stamped merged PR) attributed end-to-end; low-confidence links are excluded from headline aggregates.

### Phase 4 — Finance-grade Risk-Adjusted ROI engine + dashboards (≈ weeks 11–14)
- `services/api/` (NestJS + Prisma): OIDC auth, roles viewer/analyst/admin per tenant, CRUD, **graph + ROI query endpoints reading MVs/graph only**, OpenAPI generated. Enable Postgres **RLS** on every tenant-scoped table this phase.
- **ROI engine** with the rigor finance demands: **baseline capture** (pre-agent cost/time of a unit of work), **fully-loaded cost** (tokens + amortized integration + human QA/review + eval/monitoring + platform share), **redeployment flag** (discount benefits not actually redeployed), **confidence intervals** (propagate `attribution_confidence`), **risk-adjusted ROI** (discount by risk exposure from the risk engine), and an **auditable trail** (every ROI input traces to source events).
- `apps/dashboard/` (Next.js App Router): CFO view (spend, ROI, risk-adjusted ROI, forecast), CISO view (risk events, governance posture), agent detail (runs + unit economics + risk), budgets, settings.
- **Accept when**: cross-tenant access test fails closed; dashboard p95 < 300ms on 50M-row seeded ClickHouse; a risk-adjusted ROI figure traces fully back to source events; OpenAPI published.

### Phase 5 — Agent-Native Risk Engine (≈ weeks 15–18) — the DLP pivot
- **Tool & MCP governance**: per-agent inventory of reachable tools/MCP servers; deny-by-default allowlists; alert on first use of a new tool. (Control plane in api + Postgres; enforcement in gateway when present.)
- **Non-human identity governance**: short-lived scoped credentials per agent, approval workflows, automatic decommissioning of dormant agents, blast-radius view.
- **Semantic classification tier** (`services/workers/risk-enrichment/`): LLM-driven classifier as an **async** enrichment worker, gated on the deterministic tier's precision metrics — never on the inline path. The existing regex classifiers carry forward as the deterministic tier.
- **Injection / anomalous-action detection**: flag agent runs where behavior suggests injection drove an unintended tool call or data egress.
- Every risk event attaches to an agent/run and flows into risk-adjusted ROI.
- **Accept when**: a seeded agent with a disallowed tool call raises a governed risk event that appears in the CISO view and lowers that agent's risk-adjusted ROI.

### Phase 6 — Enterprise hardening (≈ weeks 19–22)
SSO/SCIM; k6 load test proving gateway p95 < 75ms policy overhead at 1k RPS; ClickHouse capacity at 50M events/day; FOCUS 1.2 export with `x_ai_*`; 30-day pilot report generator; Helm + Terraform; Slack alerting on budget thresholds and critical risk events.

## 4. Security Rules (hard constraints — never violate, never "temporarily" relax)

1. **No secrets in the repo, ever** — not in code, config, tests, fixtures, or docs, including realistic-format "example" keys. Config holds env-var *names*. `gitleaks` in pre-commit and CI is Phase 1, task one.
2. **Raw prompt/completion content never enters the analytics pipeline.** The event schema must never gain a raw-content field. Opt-in content capture, if ever built, is a separate encrypted object-storage path with its own ADR — do not build unless explicitly asked.
3. **Tenant isolation is non-negotiable.** Every Postgres table: tenant FK + RLS. Every ClickHouse table: ordering key starts with `tenant_id`. Every API handler: tenant from auth context, never request params. Keep a permanent CI test attempting cross-tenant reads.
4. **Parameterized queries only** — including ClickHouse. No string-built SQL, no `eval`, no shelling out with user input.
5. **Validate at the boundary** — JSON Schema on every ingest path; body size limits; reject unknown fields on control-plane writes; output-encode in the dashboard (no `dangerouslySetInnerHTML` with untrusted data).
6. **Auth hygiene** — virtual keys/tokens stored as SHA-256 hashes only; constant-time compare; plaintext shown once at creation. Short-lived session JWTs with refresh. Rate-limit auth endpoints.
7. **Least privilege** — per-service DB users with minimal grants (gateway: insert events + read config only). Connector OAuth scopes read-only. Containers non-root, distroless/alpine, read-only root FS where possible.
8. **Supply chain** — pin versions (go.sum, lockfiles, hashed requirements). CI runs `govulncheck`, `npm audit`, `pip-audit`, Semgrep/CodeQL, secret scanning on every PR; release emits an SBOM (syft) and signs images (cosign).
9. **TLS everywhere incl. internal service traffic; encrypt at rest.** Connector credentials field-encrypted in Postgres referencing a KMS key — never plaintext columns.
10. **Audit every administrative mutation** (who, what, before/after, when) via `audit_log`. Data exports are themselves audited events.
11. **Fail safely** — DLP fail-mode per tenant policy (open/closed), default open, log which applied. Gateway serves last-good config snapshot on control-plane outage. Buffer drops increment a metric; nothing fails silently.
12. **Dependency minimalism in the data plane** — gateway stays stdlib-only (Redis client the single allowed exception, behind `BudgetStore`). Justify every new dependency in the PR description.
13. **OWASP alignment** — ASVS L2 for the API; OWASP Top 10 for LLM Applications wherever model output or agent action is stored, rendered, or acted upon (the risk engine and dashboards render untrusted agent/model output — treat it as hostile).
14. **PII discipline** — minimize PII; document lawful basis; implement tenant data deletion (Postgres cascade + ClickHouse `ALTER DELETE`) in Phase 4.
15. **Ingested third-party data is untrusted** (pivot-specific) — adapter and connector inputs (LiteLLM logs, OTel spans, GitHub/Jira/Zendesk records) are validated and schema-checked before use; outcome-connector data may contain customer PII, so pull the minimum fields needed for attribution, never raw ticket/issue bodies unless a field is explicitly required and documented.

## 5. Engineering Conventions
- **TDD bias**: extend tests with every change; never reduce coverage. `make test`, `make lint`, `make e2e` pass before any change is "done."
- **Commits**: conventional (`feat(ingest): add litellm adapter`), small, reviewable. Never commit generated artifacts, binaries, or `__pycache__`.
- **Errors**: Go — wrapped with context, no panics in request paths; TS — typed problem-details responses.
- **Logging**: structured JSON; trace IDs propagated end-to-end; never log prompt content, key plaintext, or full bodies.
- **Observability**: Prometheus metrics on every service (rates, latencies, buffer drops, consumer lag); health + readiness endpoints.
- **Docs**: each service gets a README; each significant decision an ADR. Adapter/connector format assumptions documented (they drift).
- **Performance budgets**: gateway inline overhead p95 < 75ms (CI load-test gate from Phase 6); dashboard query p95 < 300ms on seeded data.
- **When uncertain**: prefer an existing pattern in the codebase; if deviating, write the ADR first and say so. Where guidance from a general skill conflicts with this file, **this file wins** — it is project law.

## 6. Definition of Done (per phase)
Complete only when: all acceptance criteria pass via `make` targets reproducibly; CI green incl. security gates; new env vars documented; e2e suite extended to cover the new path; no security-related TODOs; and an ADR exists for any decision future contributors would otherwise re-litigate.
