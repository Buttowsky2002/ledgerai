.PHONY: test test-go test-api test-sdk-typescript e2e load helm-lint build build-api build-shared-types build-sdk-typescript build-dashboard openapi delete-tenant up down lint lint-api lint-sdk-typescript api-install install-hooks security-check audit deps attr-calibration demo seed seed-demo reset-demo bootstrap-graph smoke

GATEWAY_DIR      := services/gateway
COLLECTOR_DIR    := services/collector
WORKERS_DIR      := services/workers
CONNECTORS_DIR   := services/connectors
ADAPTERS_DIR     := services/ingest/adapters
API_DIR          := services/api
SHARED_TYPES_DIR := packages/shared-types
SDK_TS_DIR       := packages/sdk-typescript
DASHBOARD_DIR    := apps/dashboard
GO_SERVICES      := $(GATEWAY_DIR) $(COLLECTOR_DIR) $(WORKERS_DIR) $(CONNECTORS_DIR) $(ADAPTERS_DIR)
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

# Advisory gateway load test (P6-F1): policy-overhead p95 < 75ms at ~1k RPS.
# Needs a running gateway pointed at a near-zero-latency mock upstream + k6 on
# PATH. NOT a blocking gate — see tests/load/README.md. Override GATEWAY_URL /
# GATEWAY_KEY / RPS / DURATION via env.
load:
	k6 run tests/load/gateway.k6.js

# ── Attribution calibration scaffolding (build-plan §6) ──────────────────────
# Prints the V1 heuristic's calibration baseline (ECE / AUC / precision@0.9) on
# the synthetic golden set — the bar the V2 attribution engine must beat. Advisory
# in sub-phase 3.0; becomes a blocking CI gate in 3.3 once the V2 scorer exists.
attr-calibration:
	cd $(WORKERS_DIR) && go test -v -run 'TestV1Baseline|Calibration|TestAUC|TestPrecision|TestReliability' ./internal/attribution/

# ── Deploy (Helm) ─────────────────────────────────────────────────────────────
HELM_CHART := deploy/helm/agentledger

# Lint + render the Helm chart. Uses a local helm if present, else a container
# (mirrors the Go-in-Docker convention). Rendering with default values proves the
# templates produce valid manifests; it does not require a live cluster.
helm-lint:
	@if command -v helm >/dev/null 2>&1; then \
		helm lint $(HELM_CHART) && helm template agentledger $(HELM_CHART) >/dev/null && echo "helm OK"; \
	else \
		echo "helm not found — running via container"; \
		docker run --rm -v "$(CURDIR):/w" -w /w alpine/helm:3.16.2 lint $(HELM_CHART) && \
		docker run --rm -v "$(CURDIR):/w" -w /w alpine/helm:3.16.2 template agentledger $(HELM_CHART) >/dev/null && echo "helm OK"; \
	fi

# ── Build ────────────────────────────────────────────────────────────────────
build: build-api build-shared-types build-sdk-typescript build-dashboard
	cd $(GATEWAY_DIR) && CGO_ENABLED=0 go build -o ../../bin/gateway .
	cd $(COLLECTOR_DIR) && CGO_ENABLED=0 go build -o ../../bin/collector .
	cd $(WORKERS_DIR) && CGO_ENABLED=0 go build -o ../../bin/ch-insert ./cmd/ch-insert
	cd $(WORKERS_DIR) && CGO_ENABLED=0 go build -o ../../bin/reconcile ./cmd/reconcile
	cd $(WORKERS_DIR) && CGO_ENABLED=0 go build -o ../../bin/pricesync ./cmd/pricesync
	cd $(CONNECTORS_DIR) && CGO_ENABLED=0 go build -o ../../bin/connector-sync ./cmd/connector-sync
	cd $(CONNECTORS_DIR) && CGO_ENABLED=0 go build -o ../../bin/outcome-sync ./cmd/outcome-sync
	cd $(ADAPTERS_DIR) && CGO_ENABLED=0 go build -o ../../../bin/litellm-adapter ./cmd/litellm

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

# Apply pending Postgres migrations to a running stack (Windows + Unix).
# Fresh volumes auto-apply on first postgres init; use this after pulling new SQL.
migrate:
	powershell -ExecutionPolicy Bypass -File deploy/postgres/migrate.ps1
	powershell -ExecutionPolicy Bypass -File deploy/clickhouse/migrate.ps1

migrate-api:
	docker compose up -d --build api

start-dashboard:
	powershell -ExecutionPolicy Bypass -File deploy/start-dashboard.ps1

migrate-dashboard:
	docker compose stop dashboard
	docker compose up -d --build dashboard

# Windows equivalent: powershell -ExecutionPolicy Bypass -File deploy/migrate-dashboard.ps1
# Pre-Docker sanity check: powershell -ExecutionPolicy Bypass -File deploy/verify-dashboard-build.ps1

# ── Demo mode (no provider keys required) ────────────────────────────────────
# Brings up the analytics backend, seeds a demo tenant with synthetic activity,
# and prints how to start the dashboard. See docs/DEPLOYMENT.md.
DEMO_TENANT := 00000000-0000-4000-8000-000000000001

demo:
	docker compose up -d postgres pg-dev-init clickhouse api
	@echo "==> waiting for the API to become healthy ..."
	@for i in $$(seq 1 60); do curl -fsS http://localhost:8094/healthz >/dev/null 2>&1 && break; sleep 2; done
	$(MAKE) seed-demo
	@echo ""
	@echo "Demo backend is up and seeded (tenant $(DEMO_TENANT)) — no provider keys needed."
	@echo "Start the dashboard:"
	@echo "  (cd $(SHARED_TYPES_DIR) && npm ci && npm run build)"
	@echo "  (cd $(DASHBOARD_DIR) && npm ci && \\"
	@echo "     BADGERIQ_API_URL=http://localhost:8094 BADGERIQ_DEV_TENANT_ID=$(DEMO_TENANT) \\"
	@echo "     BADGERIQ_DEMO_MODE=true npm run dev)"
	@echo "  → open http://localhost:3000  (a 'Demo mode' banner confirms seeded data)"
	@echo "  Clear demo data later with: make reset-demo"

# Seed (or re-seed) the demo tenant into ClickHouse + Postgres. Idempotent.
# Requires the stack to be up (`make demo` does this first).
seed seed-demo:
	powershell -ExecutionPolicy Bypass -File deploy/demo/seed-demo.ps1

# Clear the demo tenant's data (no reseed). `docker compose down -v` is the full reset.
reset-demo:
	powershell -ExecutionPolicy Bypass -File deploy/demo/seed-demo.ps1 -Reset

# Minimal agent + outcome graph for a live tenant (keeps connector spend).
# Calls POST /v1/design-partner/onboard (preset studio-live).
bootstrap-graph:
	powershell -ExecutionPolicy Bypass -File deploy/demo/bootstrap-outcome-graph.ps1

# Gateway smoke test: runs the real gateway against a built-in MOCK upstream
# (no real provider key) and asserts the full inline path. Needs Go + python3.
smoke:
	python3 $(GATEWAY_DIR)/smoke_test.py

# ── Lint ─────────────────────────────────────────────────────────────────────
lint: lint-api lint-sdk-typescript lint-dashboard
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

lint-dashboard:
	@echo "==> lint $(DASHBOARD_DIR)"
	cd $(DASHBOARD_DIR) && npm run lint && npm run typecheck

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
