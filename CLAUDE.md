# Project — Claude Code Context

## Stack

- **Go 1.22** — microservices under `/services/`
- **TypeScript / Node 20** — API layer under `/api/`
- **Next.js 14** — dashboard under `/apps/dashboard/`
- **Python 3.11** — data pipeline / ML under `/workers/`
- **PostgreSQL 16** — primary store; migrations in `/deploy/postgres/`
- **ClickHouse** — analytics; migrations in `/deploy/clickhouse/`

## Shared contract

`agentledger/schemas/events/llm_call.schema.json` is the single event schema shared by all producers and consumers.
**Never break this schema without a major version bump and cross-team review.**

## Key rules

1. No secret, token, or credential ever touches a committed file.
2. All DB migrations are forward-only and numbered.
3. Every new dependency needs a justification in the PR description.
4. Run `make lint && make test` before pushing.
5. Branch protection on `main` is non-negotiable — no direct pushes, including from admins.

## Make targets

| Target          | What it does                          |
|-----------------|---------------------------------------|
| `make install`  | Install all toolchains                |
| `make dev`      | Start all services locally            |
| `make lint`     | Run all linters                       |
| `make test`     | Run all test suites                   |
| `make build`    | Build all binaries and bundles        |
| `make migrate`  | Run pending DB migrations             |
