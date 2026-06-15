# ADR-001 — Security Toolchain Selection

**Date:** 2026-06-15
**Status:** Accepted
**Deciders:** Platform team

---

## Context

Phase 1 task one (per CLAUDE_CODE_BUILD_SPEC.md §4 rule 1 and §8) requires secret
scanning in both the pre-commit hook and CI before any feature code is added.
The gateway handles API keys, virtual keys, and PII — a leaked credential in
the repo history is permanently damaging and may be undetectable at review time.

Three decisions were made simultaneously because they form a coherent toolchain:
secret scanning, static analysis, and dependency auditing.

---

## Decisions

### Secret scanning: gitleaks

**Chosen:** gitleaks ≥ 8 (gitleaks-action v2 in CI)

**Alternatives considered:**
- `trufflehog` — excellent entropy scanning but heavier, slower on `--staged`
- GitHub native push protection — available but requires GitHub Advanced Security
  license; gitleaks is self-contained and runs locally in the pre-commit hook
- `detect-secrets` (Yelp) — Python, harder to pin in a Go-first repo

**Why gitleaks:** single static binary, first-class `protect --staged` for
pre-commit use, `--redact` prevents secrets from appearing in CI logs, extends
the well-maintained upstream ruleset, TOML allowlists are reviewable in code.

The `config.example.json` and `docker-compose.yml` are explicitly allowlisted
because they contain dev-only virtual-key names and a placeholder password
(`dev_only_change_me`) — neither matches a real secret pattern, but the
allowlist documents the decision so reviewers don't re-investigate.

### Static analysis (SAST): CodeQL + golangci-lint

**Chosen:** CodeQL (GitHub Actions) for CI-level SAST; golangci-lint locally and
in CI for fast feedback.

**golangci-lint linters enabled and why:**
| Linter | Reason |
|---|---|
| `gosec` | Gateway handles credentials, PII, and external HTTP; G-rules catch SQL injection, insecure TLS, path traversal |
| `bodyclose` | HTTP client response body leaks degrade connections silently under load |
| `noctx` | Context propagation required for trace-ID end-to-end |
| `sqlclosecheck` | Future DB work; enabling now is zero-cost |
| `errcheck` | Unchecked errors in a proxy are silent data-loss bugs |
| `staticcheck` | Catches deprecated API usage and unreachable code |

`gosec` is excluded on `_test.go` files because test fixtures intentionally use
weak patterns (e.g. predictable keys for deterministic assertions).

### Dependency auditing: govulncheck

**Chosen:** `govulncheck` (golang.org/x/vuln) for Go; future phases add
`npm audit` (TypeScript API) and `pip-audit` (Python workers).

**Why govulncheck over `go list -m` + advisory DB grep:** govulncheck performs
call-graph analysis — it only flags vulnerabilities in code paths that are
actually reachable, eliminating the false-positive noise that causes developers
to ignore audit output.

---

## Consequences

- Every developer must install gitleaks locally (`make install-hooks`) to get
  the pre-commit gate. CI enforces the same gate unconditionally.
- The `.gitleaks.toml` allowlist must be reviewed on every PR that modifies it.
  Changes to the allowlist require a second reviewer from the security team
  (enforced via CODEOWNERS once that file is updated).
- golangci-lint adds ~10s to local `make lint`. This is acceptable; the gateway
  builds in <3s so total local loop is well under 30s.
- CodeQL adds ~3–5 min to CI on Go changes. Acceptable for a security gate.
- govulncheck is pinned by `go.sum` transitively; no separate version pin needed.
