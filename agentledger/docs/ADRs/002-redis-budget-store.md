# ADR-002 — Redis-backed Budget Store

**Date:** 2026-06-15
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 1, task 2 (CLAUDE_CODE_BUILD_SPEC.md §3)

---

## Context

The in-process `MemBudgetStore` resets counters on gateway restart and does not
share state across replicas. The Phase 1 acceptance criterion "budget survives
gateway restart" requires an external counter store.

Requirements:
1. Monthly spend per virtual key persists across gateway restarts.
2. Counters are consistent across horizontal gateway replicas behind the LB.
3. Pre-flight budget and rate-limit checks stay within the 75 ms p95 overhead
   budget (they are on the inline hot path).
4. The gateway remains stdlib-only except for this one dependency.
5. Async drain of MTD spend for the Postgres monthly-close workflow.

---

## Decision

### Store: Redis with INCRBYFLOAT

Redis `INCRBYFLOAT` provides atomic float increment with single-digit millisecond
latency from a co-located cluster — well within the hot-path budget. Budget check
is a single `GET` (pre-flight read, no write); the write (`INCRBYFLOAT`) happens
post-flight once cost is known, matching the existing MemBudgetStore semantics.

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| Postgres `UPDATE ... RETURNING` | 5–20 ms under load; violates the "zero I/O inline" principle |
| Memcached | No atomic float increment; no sorted-set for rate limiting |
| etcd | Overkill; inconsistent with "dependency minimalism" rule |
| Sticky-session LB | Breaks horizontal scaling; counter still lost on restart |

### Rate limiting: Redis sorted-set Lua script

The sliding-window rate limiter uses a ZSET keyed by `al:rate:{virtualKey}`,
with scores = float64 Unix timestamp (nanosecond precision). A Lua script
atomically removes stale entries, checks the count, and conditionally adds the
new slot — preventing the TOCTOU race inherent in a read-check-write sequence.

Member IDs are `{nanos}.{monotonic-counter}` to ensure uniqueness even when two
requests arrive at the same nanosecond in the same process.

### Key expiry

Budget keys expire 7 days after month-end (`monthKeyTTL`). This keeps the
reconciliation window open: if the connector pipeline reconciles provider-billed
cost against gateway-observed spend up to 7 days after month-close, the Redis
key is still readable. After that, the Postgres drain table becomes the source.

### Dependency: `github.com/redis/go-redis/v9`

This is the single allowed external dependency per CLAUDE_CODE_BUILD_SPEC.md §4
rule 12 ("Redis client is the single allowed exception, behind the BudgetStore
interface"). The `BudgetStore` interface ensures the Redis client is isolated
behind an abstraction — all other gateway code is stdlib-only.

Test dependency: `github.com/alicebob/miniredis/v2` provides a pure-Go in-process
Redis server for unit tests, eliminating the need for a Redis sidecar in CI.

### Drain to Postgres

A background goroutine fires every 5 minutes and once on shutdown, scanning
`al:budget:*` keys and calling a `SpendDrainFn` callback. In Phase 1 this
callback logs to `slog`. In Phase 3, when the control-plane Postgres connection
pool is added, the callback will write to a `budget_spend_mtd` table for the
monthly-close workflow. This design keeps the gateway stdlib+Redis-only while
providing a clean hook for the future Postgres write.

---

## Consequences

- **Positive**: Budget survives gateway restart; consistent across replicas.
- **Positive**: One new dependency, isolated behind the interface.
- **Negative**: Redis is a new infrastructure dependency for production. Local
  dev via `docker compose up` is unaffected (Redis added to docker-compose.yml).
- **Risk**: Redis unavailability → CheckAndCount fails-open (a slog.Warn is
  emitted, the request proceeds). This is intentional: gateway availability
  takes priority over budget precision; provider reconciliation backstops accuracy.
  Tenants that require hard-limit enforcement in fail-closed mode will need a
  separate gate at the API layer (out of scope for Phase 1).
- **Future**: If Redis becomes a performance bottleneck (e.g. >10k RPS), the
  two-layer approach (in-process counter + async Redis sync every N requests) can
  be adopted without changing the `BudgetStore` interface.
