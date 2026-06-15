# Contributing Guide

## Prerequisites

- Go 1.22+
- Node.js 20+
- Python 3.11+
- Docker

## Local setup

```bash
make install   # install all language toolchains
make dev       # start all services locally
```

## Branching

- Branch off `main`
- Name: `<type>/<short-description>` e.g. `feat/llm-call-schema-v2`
- Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`

## Pull requests

1. Fill in the PR template completely — especially the **new dependency** and **migration** checkboxes.
2. Keep PRs focused. One logical change per PR.
3. All CI checks must be green before requesting review.
4. Squash-merge only.

## Dependency policy

Every new dependency requires a justification comment in the PR description explaining:
- Why an existing package cannot solve the problem
- The dependency's license
- Its maintenance status (last commit, open issues)

## Migrations

Database migrations under `deploy/postgres/` and `deploy/clickhouse/` are **forward-only and numbered sequentially**. A reverted application commit must never imply a reverted migration. State this explicitly in your PR description if your change includes a migration.

## Code style

| Language   | Formatter      | Linter        |
|------------|---------------|---------------|
| Go         | `gofmt`        | `golangci-lint` |
| TypeScript | `prettier`     | `eslint`      |
| Python     | `ruff format`  | `ruff`        |

Run `make lint` before pushing.
