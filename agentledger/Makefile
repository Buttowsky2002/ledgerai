.PHONY: test build up down lint install-hooks security-check audit deps

GATEWAY_DIR := services/gateway
HOOKS_DIR   := .githooks
GIT_HOOKS   := $(shell git rev-parse --git-dir 2>/dev/null)/hooks

# ── Tests ────────────────────────────────────────────────────────────────────
test:
	cd $(GATEWAY_DIR) && go vet ./... && go test -race ./...

# ── Build ────────────────────────────────────────────────────────────────────
build:
	cd $(GATEWAY_DIR) && CGO_ENABLED=0 go build -o ../../bin/gateway .

# ── Local stack ──────────────────────────────────────────────────────────────
up:
	docker compose up -d

down:
	docker compose down

# ── Lint ─────────────────────────────────────────────────────────────────────
lint:
	cd $(GATEWAY_DIR) && gofmt -l . && go vet ./...

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
	cd $(GATEWAY_DIR) && go install golang.org/x/vuln/cmd/govulncheck@latest && govulncheck ./...

# ── Module tidy (generate / update go.sum) ───────────────────────────────────
# Run this after editing go.mod or adding imports. Requires Go installed locally.
# Without Go: docker run --rm -v "$(CURDIR)/$(GATEWAY_DIR):/w" -w /w golang:1.22-alpine go mod tidy
deps:
	cd $(GATEWAY_DIR) && go mod tidy
