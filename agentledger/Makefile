.PHONY: test test-go test-api test-sdk-typescript e2e build build-api build-shared-types build-sdk-typescript build-dashboard openapi delete-tenant up down lint lint-api lint-sdk-typescript api-install install-hooks security-check audit deps

GATEWAY_DIR      := services/gateway
COLLECTOR_DIR    := services/collector
WORKERS_DIR      := services/workers
CONNECTORS_DIR   := services/connectors
API_DIR          := services/api
SHARED_TYPES_DIR := packages/shared-types
SDK_TS_DIR       := packages/sdk-typescript
DASHBOARD_DIR    := apps/dashboard
GO_SERVICES      := $(GATEWAY_DIR) $(COLLECTOR_DIR) $(WORKERS_DIR) $(CONNECTORS_DIR)
HOOKS_DIR      := .githooks
GIT_HOOKS      := $(shell git rev-parse --git-dir 2>/dev/null)/hooks

# ── Tests ────────────────────────────────────────────────────────────────────
# `test` is infra-free (unit). The RLS cross-tenant isolation suite needs a live
# Postgres and runs under `e2e`.
test: test-go test-api test-sdk-typescript

test-go:
	@for d in $(GO_SERVICES); do \
		echo "==> test $$d"; \
		(cd $$d && go vet ./... && go test -race ./...) || exit 1; \
	done

test-api:
	@echo "==> test $(API_DIR)"
	cd $(API_DIR) && npm test

test-sdk-typescript:
	@echo "==> test $(SDK_TS_DIR)"
	cd $(SDK_TS_DIR) && npm test

# API e2e: tenant isolation, auth/RBAC, CRUD+audit, and analytics. Needs Postgres
# (migrations + dev role) and ClickHouse (MVs for analytics).
e2e:
	docker compose up -d postgres pg-dev-init clickhouse
	cd $(API_DIR) && npm run test:e2e

# ── Build ────────────────────────────────────────────────────────────────────
build: build-api build-shared-types build-sdk-typescript build-dashboard
	cd $(GATEWAY_DIR) && CGO_ENABLED=0 go build -o ../../bin/gateway .
	cd $(COLLECTOR_DIR) && CGO_ENABLED=0 go build -o ../../bin/collector .
	cd $(WORKERS_DIR) && CGO_ENABLED=0 go build -o ../../bin/ch-insert ./cmd/ch-insert
	cd $(WORKERS_DIR) && CGO_ENABLED=0 go build -o ../../bin/reconcile ./cmd/reconcile
	cd $(CONNECTORS_DIR) && CGO_ENABLED=0 go build -o ../../bin/connector-sync ./cmd/connector-sync
	cd $(CONNECTORS_DIR) && CGO_ENABLED=0 go build -o ../../bin/outcome-sync ./cmd/outcome-sync

build-api:
	cd $(API_DIR) && npm run build

build-shared-types:
	cd $(SHARED_TYPES_DIR) && npm run build

build-sdk-typescript:
	cd $(SDK_TS_DIR) && npm run build

# Dashboard build (Next.js); needs shared-types built first (file: dependency).
build-dashboard:
	cd $(DASHBOARD_DIR) && npm run build

# Regenerate the published OpenAPI spec (docs/api/openapi.json) and the TS client.
openapi:
	cd $(API_DIR) && npm run generate:openapi
	cd $(SHARED_TYPES_DIR) && npm run generate && npm run build

# Tenant data-deletion job (rule 14). Destructive: Postgres cascade + ClickHouse
# ALTER DELETE. Usage: make delete-tenant TENANT=<tenant-uuid>
delete-tenant:
	cd $(API_DIR) && node dist/cli/delete-tenant.js $(TENANT)

# Install API toolchain (CI runs this before lint/test).
api-install:
	cd $(API_DIR) && npm ci
	cd $(SHARED_TYPES_DIR) && npm ci
	cd $(SDK_TS_DIR) && npm ci
	cd $(DASHBOARD_DIR) && npm ci

# ── Local stack ──────────────────────────────────────────────────────────────
up:
	docker compose up -d

down:
	docker compose down

# ── Lint ─────────────────────────────────────────────────────────────────────
lint: lint-api lint-sdk-typescript
	@for d in $(GO_SERVICES); do \
		echo "==> lint $$d"; \
		(cd $$d && gofmt -l . && go vet ./...) || exit 1; \
	done

lint-api:
	@echo "==> lint $(API_DIR)"
	cd $(API_DIR) && npm run lint

lint-sdk-typescript:
	@echo "==> lint $(SDK_TS_DIR)"
	cd $(SDK_TS_DIR) && npm run lint

# ── Pre-commit hook installation ─────────────────────────────────────────────
# Copies the versioned hook into .git/hooks and marks it executable.
# Run once after cloning: make install-hooks
install-hooks:
	@if [ -z "$(GIT_HOOKS)" ]; then \
		echo "ERROR: not inside a git repository"; exit 1; \
	fi
	@mkdir -p "$(GIT_HOOKS)"
	cp $(HOOKS_DIR)/pre-commit "$(GIT_HOOKS)/pre-commit"
	chmod +x "$(GIT_HOOKS)/pre-commit"
	@echo "✓ pre-commit hook installed at $(GIT_HOOKS)/pre-commit"
	@echo "  Requires gitleaks >= 8: https://github.com/gitleaks/gitleaks#installing"

# ── Local secret scan ────────────────────────────────────────────────────────
# Mirrors what CI runs; useful before pushing.
security-check:
	@command -v gitleaks >/dev/null 2>&1 || \
		(echo "ERROR: gitleaks not installed. See https://github.com/gitleaks/gitleaks#installing"; exit 1)
	gitleaks detect --config=.gitleaks.toml --redact --verbose

# ── Dependency vulnerability audit ───────────────────────────────────────────
audit:
	@for d in $(GO_SERVICES); do \
		echo "==> audit $$d"; \
		(cd $$d && go install golang.org/x/vuln/cmd/govulncheck@latest && govulncheck ./...) || exit 1; \
	done

# ── Module tidy (generate / update go.sum) ───────────────────────────────────
# Run this after editing go.mod or adding imports. Requires Go installed locally.
# Without Go: docker run --rm -v "$(CURDIR)/$(GATEWAY_DIR):/w" -w /w golang:1.22-alpine go mod tidy
deps:
	@for d in $(GO_SERVICES); do \
		echo "==> tidy $$d"; \
		(cd $$d && go mod tidy) || exit 1; \
	done
