.PHONY: install dev lint test build migrate clean

# ── Install all toolchains ───────────────────────────────────────────
install:
	@echo "→ Go tools"
	go install golang.org/x/vuln/cmd/govulncheck@latest
	go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	@echo "→ Node (api)"
	cd api && npm ci
	@echo "→ Node (dashboard)"
	cd apps/dashboard && npm ci
	@echo "→ Python"
	cd workers && pip install -r requirements.txt -r requirements-dev.txt
	@echo "→ pip-audit"
	pip install pip-audit

# ── Local development ────────────────────────────────────────────────
dev:
	docker compose up --build

# ── Lint all languages ───────────────────────────────────────────────
lint: lint-go lint-ts lint-frontend lint-python

lint-go:
	golangci-lint run ./...

lint-ts:
	cd api && npm run lint

lint-frontend:
	cd apps/dashboard && npm run lint

lint-python:
	cd workers && ruff check . && ruff format --check .

# ── Test all languages ───────────────────────────────────────────────
test: test-go test-ts test-frontend test-python

test-go:
	go test -race -coverprofile=coverage-go.out ./...

test-ts:
	cd api && npm test

test-frontend:
	cd apps/dashboard && npm test

test-python:
	cd workers && pytest --tb=short

# ── Build ────────────────────────────────────────────────────────────
build: build-go build-ts build-frontend

build-go:
	go build -o bin/ ./...

build-ts:
	cd api && npm run build

build-frontend:
	cd apps/dashboard && npm run build

# ── Database migrations ──────────────────────────────────────────────
migrate:
	@echo "→ PostgreSQL migrations"
	cd deploy/postgres && ./migrate.sh
	@echo "→ ClickHouse migrations"
	cd deploy/clickhouse && ./migrate.sh

# ── Security audits (run locally before pushing) ─────────────────────
audit:
	govulncheck ./...
	cd api && npm audit --audit-level=high
	cd apps/dashboard && npm audit --audit-level=high
	cd workers && pip-audit

# ── Clean ────────────────────────────────────────────────────────────
clean:
	rm -rf bin/ dist/ coverage-*.out
	cd api && rm -rf dist/ node_modules/.cache
	cd apps/dashboard && rm -rf .next/ dist/ node_modules/.cache
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
