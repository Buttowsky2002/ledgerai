# CLAUDE.md — AgentLedger AI Build Specification
<!--
HOW TO USE THIS FILE:
1. Create a new git repository.
2. Unzip agentledger.zip into the repo root (its contents become the seed code).
3. Place this file at the repo root as CLAUDE.md.
4. Also copy docs/ARCHITECTURE.md from the zip (Claude Code should read it before any phase).
5. Open Claude Code in the repo and say: "Read CLAUDE.md and ARCHITECTURE.md, then begin Phase 1."
Claude Code will treat everything below as standing instructions for the whole project.
-->

## 1. Project Context

You are building **AgentLedger AI**, an AI FinOps control plane: spend attribution, agent unit economics, inline DLP, and risk-adjusted ROI for companies using LLM APIs and AI agents.

A **working data plane already exists in this repository** — do not rewrite it:
- `services/gateway/` — Go 1.22, stdlib-only, OpenAI-compatible gateway. 8 passing unit tests + `smoke_test.py`. Handles virtual-key auth, budgets, rate limits, deterministic DLP (redact/block), streaming with usage capture, cache-aware cost computation, async event emission.
- `deploy/postgres/001_core.sql` — control-plane schema (tenants, identities, agents, virtual keys as hashes, policies, price book, budgets, audit log).
- `deploy/clickhouse/001_events.sql` — `llm_calls` ReplacingMergeTree + SummingMergeTree MVs (`spend_daily`, `spend_hourly_by_key`, `risk_daily`) + `v_unit_economics`.
- `packages/sdk-python/` — stdlib-only tracing SDK (run/step/outcome model, fire-and-forget, never raises).
- `pricing/pricebook.json`, `docker-compose.yml`, `Makefile`.

**Read `docs/ARCHITECTURE.md` in full before writing any code.** Its decisions are binding: FOCUS 1.2 as export schema, OTel GenAI semantic conventions in telemetry, ClickHouse + incremental MVs for analytics, Go for the data plane / TypeScript for the control plane, and the governing rule that **the gateway inline path performs zero I/O** — anything heavy is async behind the event bus.

## 2. Target Repository Structure

Evolve the repo toward this layout. Create directories as their phase begins; do not scaffold empty dirs speculatively.

```
agentledger/
├── CLAUDE.md                        # this file
├── README.md
├── Makefile                         # one target per common task; CI calls these
├── docker-compose.yml               # full local stack
├── .github/
│   └── workflows/
│       ├── ci.yml                   # lint + test + SAST + secret scan + dep audit
│       └── release.yml              # build, SBOM, sign, push images
├── docs/
│   ├── ARCHITECTURE.md
│   ├── ADRs/                        # one markdown file per significant decision
│   ├── RUNBOOKS/                    # incident response, key rotation, on-call
│   └── api/                         # OpenAPI specs, generated
├── services/
│   ├── gateway/                     # EXISTING — Go data plane (extend, don't rewrite)
│   ├── collector/                   # Phase 1 — Go ingest service: SDK/OTel events → Redpanda
│   ├── workers/                     # Phase 1+ — Go async consumers: enrich, dedup, CH insert,
│   │                                #   reconciliation, anomaly detection (one cmd per worker)
│   ├── connectors/                  # Phase 2 — Go provider/business importers
│   │   ├── openai-usage/  anthropic-usage/  bedrock/  vertex/
│   │   └── github/  jira/  zendesk/         # Phase 4 outcome connectors
│   └── api/                         # Phase 3 — NestJS control-plane API (TypeScript)
├── apps/
│   └── dashboard/                   # Phase 3 — Next.js (App Router) frontend
├── packages/
│   ├── sdk-python/                  # EXISTING
│   ├── sdk-typescript/              # Phase 4 — mirror of the Python SDK
│   └── shared-types/                # generated TS types from OpenAPI + event JSON Schema
├── schemas/
│   ├── events/llm_call.schema.json  # canonical event JSON Schema — single source of truth
│   └── focus/                       # FOCUS 1.2 column mapping + x_ai_* extension spec
├── deploy/
│   ├── postgres/                    # numbered migrations: 001_, 002_ ... (golang-migrate)
│   ├── clickhouse/                  # numbered migrations
│   ├── helm/                        # Phase 5 — production charts
│   └── terraform/                   # Phase 5 — cloud infra
├── pricing/pricebook.json
└── tests/
    ├── e2e/                         # docker-compose based end-to-end suites
    └── load/                        # k6 scripts; gateway p95 budget enforcement
```

Conventions: Go services use `cmd/` + `internal/` once they exceed one package. All DB changes are numbered, forward-only migrations — never edit an applied migration. The event JSON Schema in `schemas/events/` is the contract between SDK, collector, workers, and ClickHouse; change it only with a versioned migration plan.

## 3. Build Phases (work in order; each has acceptance criteria)

### Phase 1 — Harden the data plane (≈ weeks 1–2)
1. **Redis budget store**: implement the existing `BudgetStore` interface backed by Redis (atomic INCRBYFLOAT month keys, TTL at month end). Gateway flag selects memory vs redis. Async drain of realized spend to Postgres.
2. **Config hot-reload**: gateway polls Postgres (or LISTEN/NOTIFY) for keys/policies/prices; atomically swaps an immutable config snapshot; serves last-known-good if Postgres is unreachable.
3. **Anthropic-native translation**: `/v1/messages` endpoint translating Messages API ↔ internal canonical request, including streaming and cache-token accounting.
4. **Collector service** (`services/collector/`): HTTP ingest for SDK events, validates against `schemas/events/`, writes to Redpanda topic `events.raw`, returns 202. Backpressure → 429, never blocks.
5. **CH insert worker** (`services/workers/`): consumes `events.raw`, batches JSONEachRow inserts to ClickHouse, dead-letters poison messages.
- **Accept when**: `make test` green; e2e test proves SDK event → collector → Redpanda → ClickHouse row; gateway sustains config reload under load with zero dropped requests; budget survives gateway restart.

### Phase 2 — Provider connectors + reconciliation (≈ weeks 3–5)
Connector framework (cursor-based incremental sync, per-connector rate limiting, retries with jitter, state in Postgres `connectors` table) and four importers: OpenAI usage/costs API, Anthropic usage API, AWS Bedrock, GCP Vertex. Reconciliation worker diffs gateway-observed cost vs provider-billed cost per day/model/key, books adjustment events, flags drift > 2%.
- **Accept when**: connectors replay from cursor after crash without duplicates (ReplacingMergeTree dedup verified); reconciliation report query returns per-day drift.

### Phase 3 — Control-plane API + dashboards (≈ weeks 6–9)
- `services/api/`: NestJS + Prisma on Postgres. AuthN: OIDC (start with Google/Microsoft), session JWTs. AuthZ: roles viewer/analyst/admin per tenant. CRUD for tenants, teams, identities, apps, agents, keys (create returns plaintext once), policies, budgets, price book, allocation rules. All analytics endpoints query ClickHouse MVs only — never raw `llm_calls` for dashboard paths. OpenAPI spec generated; TS client into `packages/shared-types`.
- `apps/dashboard/`: Next.js App Router. Pages: Executive spend, Allocation (team/app/agent), Model mix, Budget burn-down, Risk events, Agent detail (runs + unit economics), Settings (keys, policies, budgets). Read `/mnt/skills`-style design guidance if available; otherwise clean, dense, data-first UI.
- Enable Postgres **row-level security** on every tenant-scoped table in the same phase the API lands; API sets `app.tenant_id` per request.
- **Accept when**: cross-tenant access test fails closed (tenant A token cannot read tenant B by any route); dashboard p95 < 300ms against 50M-row seeded ClickHouse; OpenAPI published.

### Phase 4 — ROI engine (≈ weeks 10–12)
GitHub/Jira/Zendesk outcome connectors; attribution matcher worker (time-window + identity + branch/issue correlation → `attribution_confidence`); ROI template CRUD + editor page; cost-per-outcome dashboards over `v_unit_economics`; TypeScript SDK mirroring the Python one.
- **Accept when**: seeded demo shows "cost per resolved ticket" with confidence; outcomes with confidence < threshold visibly excluded from headline numbers.

### Phase 5 — Pilot hardening (≈ weeks 13–16)
SSO/SCIM; k6 load test proving gateway p95 < 75ms policy overhead at 1k RPS; ClickHouse capacity validation at 50M events/day; FOCUS 1.2 CSV/Parquet export with `x_ai_*` columns per `schemas/focus/`; 30-day pilot report generator (PDF/HTML); Helm charts + Terraform; alerting (Slack webhook) on budget thresholds and critical DLP events.

## 4. Security Rules (hard constraints — never violate, never "temporarily" relax)

1. **No secrets in the repo, ever.** No API keys, passwords, or tokens in code, config, tests, fixtures, or docs — including "example" keys that match real formats. Config files hold env-var *names*. Add `gitleaks` to pre-commit and CI in Phase 1, task one.
2. **Raw prompt/completion content never enters the analytics pipeline.** The event schema must never gain a raw-content field. Content capture, if a tenant opts in later, is a separate encrypted object-storage path with its own ADR — do not build it unless explicitly asked.
3. **Tenant isolation is non-negotiable.** Every new Postgres table: tenant FK + RLS policy. Every new ClickHouse table: ordering key starts with `tenant_id`. Every API handler: tenant derived from auth context, never from request params. Maintain a permanent CI test attempting cross-tenant reads.
4. **Parameterized queries only.** No string-concatenated SQL anywhere, including ClickHouse (use parameter binding). No `eval`, no shelling out with user input.
5. **Validate at the boundary.** JSON Schema validation on every ingest path; request body size limits; reject unknown fields on control-plane writes; output encoding in the dashboard (React defaults + no `dangerouslySetInnerHTML` with user data).
6. **Auth hygiene.** Virtual keys and any tokens stored as SHA-256 hashes only; constant-time comparison; plaintext shown exactly once at creation. Session JWTs short-lived with refresh. Rate-limit auth endpoints.
7. **Least privilege.** Per-service DB users with minimal grants (gateway: insert events + read config only). Connector OAuth scopes read-only. Containers run as non-root, distroless/alpine base, read-only root FS where possible.
8. **Supply chain.** Pin versions (go.sum, package-lock, requirements with hashes). CI runs `govulncheck`, `npm audit`, `pip-audit`, Semgrep (or CodeQL), and secret scanning on every PR; release workflow emits an SBOM (syft) and signs images (cosign).
9. **TLS everywhere; encrypt at rest.** Internal service traffic included. Connector credentials field-encrypted in Postgres referencing a KMS key — never plaintext columns.
10. **Audit log every administrative mutation** (who, what, before/after, when) using the existing `audit_log` table. Exports of data are themselves audited events.
11. **Fail safely.** DLP fail-mode per tenant policy (open/closed) — implement both, default open, log which applied. Gateway serves last-good config snapshot on control-plane outage. Event-buffer drops increment a metric; nothing fails silently.
12. **Dependency minimalism in the data plane.** The gateway stays stdlib-only (Redis client is the single allowed exception, behind the BudgetStore interface). Justify every new dependency in the PR description.
13. **OWASP alignment.** Apply OWASP ASVS L2 for the API and the OWASP Top 10 for LLM Applications wherever model output is stored, rendered, or acted upon (the dashboard renders DLP findings — treat them as untrusted).
14. **PII discipline.** Identities table stores work emails as the only PII; document lawful basis; implement tenant data deletion (cascade + ClickHouse `ALTER DELETE` job) in Phase 3.

## 5. Engineering Conventions

- **TDD bias**: write or extend tests with every change; do not reduce existing coverage. `make test`, `make lint`, `make e2e` must pass before any commit you declare done.
- **Commits**: conventional commits (`feat(gateway): ...`), small and reviewable. Never commit generated artifacts, binaries, or `__pycache__` (extend `.gitignore` first).
- **Errors**: Go — wrapped errors with context, no panics in request paths; TS — typed error responses matching a documented problem-details shape.
- **Logging**: structured JSON everywhere; request/trace IDs propagated end-to-end; never log prompt content, key plaintext, or full request bodies.
- **Observability**: Prometheus metrics on every service (request rates, latencies, buffer drops, consumer lag); health + readiness endpoints.
- **Docs**: every new service gets a README (purpose, run, env vars); every significant decision gets an ADR in `docs/ADRs/`.
- **Performance budgets**: gateway inline overhead p95 < 75ms is a CI-enforced load-test gate from Phase 5 on; dashboard query p95 < 300ms against seeded data.
- **When uncertain**: prefer the pattern already in the codebase; if deviating, write the ADR first and say so.

## 6. Definition of Done (per phase)

A phase is complete only when: all acceptance criteria pass via `make` targets reproducibly; CI is green including security gates; new env vars documented; e2e suite extended to cover the new path; no TODOs referencing security; and a short `docs/ADRs/` entry exists for any decision that future contributors would otherwise re-litigate.
