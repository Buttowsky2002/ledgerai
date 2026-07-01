# ADR-003 — Gateway Config Hot-Reload from Postgres

**Date:** 2026-06-16
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 1, task 3 (CLAUDE_CODE_BUILD_SPEC.md §3)

---

## Context

The gateway boots from a static JSON file (`config.go`). In production, virtual
keys, DLP policies, and prices are owned by the control-plane Postgres database
and change while the gateway runs — a key is revoked, a budget is raised, a DLP
policy is tightened. Restarting every replica to pick up a single key change is
unacceptable.

The Phase 1 acceptance criterion is explicit: **"gateway sustains config reload
under load with zero dropped requests."** Two constraints follow:

1. A reload must never tear a request's view of config — an in-flight request
   must see one consistent (keys, policies, prices) triple start to finish.
2. If Postgres is unreachable, the gateway must keep serving the last-known-good
   config (per §4 rule 11, "fail safely … serves last-good config snapshot on
   control-plane outage"), never fail closed and drop traffic.

---

## Decision

### Immutable snapshot swapped via `atomic.Pointer`

All hot-reloadable config is bundled into an immutable `gatewaySnapshot`
(`config_snapshot.go`): the `*Config`, the `*KeyStore`, the `*DLPEngine`, and the
`*PriceBook`. The `Gateway` holds exactly one `atomic.Pointer[gatewaySnapshot]`.

- **Readers** (`handleChatCompletions`) call `g.current.Load()` **once** at the
  top of the request and use that snapshot for the entire request lifetime.
- **The reloader** builds a brand-new snapshot off the hot path and calls
  `g.current.Store()` — a single atomic pointer swap.

Because snapshots are never mutated after construction, a reload that lands
mid-request cannot affect that request: it already holds its own pointer. This
is the lock-free read, copy-on-write pattern — no `RWMutex` on the hot path, so
reload imposes zero added latency and drops zero requests.

**Alternatives considered:**

| Option | Rejected because |
|---|---|
| `RWMutex` guarding mutable fields | Writers block all readers during swap; reload contends with the hot path |
| Mutate `KeyStore`/`DLPEngine` in place under their own locks | A request could read keys from gen N and policies from gen N+1 — a torn, inconsistent view |
| LISTEN/NOTIFY push instead of polling | More moving parts; a dropped notification silently stales config. Polling is simpler and self-healing. Revisit if 30 s staleness proves too slow. |

### Polling, not LISTEN/NOTIFY (for now)

`StartHotReload` (`config_store.go`) polls every 30 s via a ticker goroutine that
exits on context cancel. Polling is stateless and self-healing: a transient
Postgres blip just means one skipped cycle, and the next tick recovers with no
missed-notification edge cases. LISTEN/NOTIFY remains a future optimization
behind the same `ConfigStore` interface if sub-30s propagation is needed.

### Fail-safe: retain last-known-good

`reloadOnce` calls `store.Load(ctx)`; on **any** error it logs `slog.Warn` and
**returns without swapping**, leaving the current snapshot live. The price book
reload is independently fault-tolerant — a bad price file retains current prices
rather than poisoning an otherwise-good key/policy reload. Initial boot also
degrades gracefully: if the first Postgres load fails, the gateway serves the
file-based config it already loaded and keeps retrying on the ticker.

### `ConfigStore` interface + `PGConfigStore`

Reload source sits behind a `ConfigStore` interface (`Load(ctx) (*Config, error)`
+ `Close()`), so tests inject a mock and production uses `PGConfigStore`
(`config_pg.go`). Static fields (`listen_addr`, `providers`, `events`, `redis`)
come from the boot `Config`; only `virtual_keys` and DLP `policies` are
refreshed — these are the rows that change at runtime. Queries are fully
parameterized / fixed-text (§4 rule 4); revoked keys (`revoked_at IS NULL`) and
disabled policies (`enabled = true`) are filtered in SQL.

### Keys stored as SHA-256 hash, never plaintext

Postgres stores `virtual_keys.key_hash` (SHA-256 hex), never the plaintext
`alk_` secret (§4 rule 6). To unify the two construction paths, `KeyStore` now
keys its map by hash in **both** modes:

- `NewKeyStore` (file config) hashes each plaintext key at construction.
- `NewKeyStoreFromHashed` (Postgres) uses the stored hash directly.
- `Lookup(bearer)` hashes the incoming bearer token before the map lookup.

The gateway therefore never retains plaintext virtual keys in memory, regardless
of config source. (Constant-time comparison is not required here: the lookup is a
hash-keyed map probe, not a secret-vs-secret byte compare — an attacker cannot
learn the stored hash from map timing.)

### Opt-in via `BADGERIQ_PG_DSN`

Hot-reload activates only when `BADGERIQ_PG_DSN` is set (`main.go`). Empty →
the gateway behaves exactly as before (static file config), preserving the
zero-runtime-dependency MVP path and all existing tests. The Postgres connection
pool is capped small (3 open / 1 idle) — config polling is low-volume.

### Dependency: `github.com/lib/pq`

A pure-Go Postgres driver, added per §4 rule 3 (justify every dependency). It is
confined to `config_pg.go`; the hot path (`proxy.go`) remains stdlib-only. `pq`
is mature, dependency-free, and the de-facto stdlib `database/sql` driver.

---

## Consequences

- **Positive**: Key revocations and policy changes propagate within 30 s with no
  restart and zero dropped requests (lock-free atomic swap, verified under `-race`).
- **Positive**: Control-plane outage degrades to stale-but-serving, never to
  dropped traffic.
- **Positive**: Plaintext virtual keys no longer live in gateway memory.
- **Negative**: Up to 30 s of staleness after a control-plane change (e.g. a
  revoked key keeps working briefly). Acceptable for Phase 1; tighten via
  LISTEN/NOTIFY later if required.
- **Negative**: One new dependency (`lib/pq`), isolated to the config loader.
- **Future**: The `ConfigStore` interface is the seam for LISTEN/NOTIFY or a
  control-plane gRPC push without touching the hot path or the snapshot model.
