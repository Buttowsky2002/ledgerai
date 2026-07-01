package main

import (
	"strconv"
	"strings"
	"sync"
	"time"
)

// BudgetReservation is a hold placed on a virtual key's monthly budget at the
// start of a request. The reserved (estimated) amount is later adjusted to the
// actual cost via Commit, or returned in full via Release when no billable
// upstream call occurred. A reservation is single-use: the inline path calls
// exactly one of Commit/Release; both are guarded so a stray second call is a
// no-op.
type BudgetReservation struct {
	keyID   string
	month   string  // accounting month the hold was booked under (YYYY-MM)
	amount  float64 // currently-held USD (the estimate until Commit adjusts it)
	noop    bool    // backend was unavailable under fail-open; Commit/Release do nothing
	applied bool    // set once Commit/Release has run (single-use guard)
}

// BudgetStore is the spend-tracking and rate-limit enforcement contract.
//
// The lifecycle is Reserve → (Commit | Release):
//   - Reserve checks the monthly budget + RPM and immediately holds an estimate.
//   - Commit adjusts that hold to the realized cost once the upstream responds.
//   - Release returns the hold when no billable upstream call happened.
//
// Two implementations ship: MemBudgetStore (single-process, ephemeral, zero-deps,
// concurrency-safe under a mutex) and RedisBudgetStore (shared across replicas,
// restart-durable, atomic reserve via a Lua script). Select at startup via
// Config.Redis.Addr: empty → mem, non-empty → redis.
type BudgetStore interface {
	// Reserve checks the monthly budget and per-minute rate limit and, on success,
	// immediately holds estimatedUSD against the key. Returns (reservation, true,
	// "") on success or (nil, false, reason) on rejection. The check and the hold
	// are atomic, so concurrent reservers can exceed the cap by at most one hold.
	Reserve(vk *VirtualKey, estimatedUSD float64) (*BudgetReservation, bool, string)

	// Commit adjusts a hold from its estimate to the actual realized cost.
	Commit(res *BudgetReservation, actualUSD float64)

	// Release returns a hold in full (no billable upstream call occurred).
	Release(res *BudgetReservation)

	// Snapshot returns current MTD spend for the /v1/usage endpoint.
	Snapshot() map[string]any

	// Close flushes pending drains and releases connection pools / goroutines.
	Close() error
}

// budgetConfig holds budget-reservation tunables, read from the environment.
type budgetConfig struct {
	// defaultReserveUSD is held when a request carries no max_tokens to estimate
	// from. BADGERIQ_DEFAULT_RESERVE_USD (deprecated BADGERIQ_DEFAULT_RESERVE_USD).
	defaultReserveUSD float64
	// failClosed governs behavior when the budget backend (Redis) errors:
	// reject the request (true) or allow it (false). BADGERIQ_BUDGET_FAIL_MODE=open|closed.
	failClosed bool
}

// defaultReserveFallbackUSD is used when no BADGERIQ_DEFAULT_RESERVE_USD is set.
const defaultReserveFallbackUSD = 0.01

// loadBudgetConfig reads budget tunables from the environment, preferring the
// LEDGERAI_* names with the deprecated AGENTLEDGER_* fallback (see lookupEnv).
func loadBudgetConfig() budgetConfig {
	c := budgetConfig{defaultReserveUSD: defaultReserveFallbackUSD}
	if v := lookupEnv("BADGERIQ_DEFAULT_RESERVE_USD"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 {
			c.defaultReserveUSD = f
		}
	}
	c.failClosed = strings.EqualFold(lookupEnv("BADGERIQ_BUDGET_FAIL_MODE"), "closed")
	return c
}

// MemBudgetStore is the in-process BudgetStore implementation. Counters are
// per-process and ephemeral (reset on restart, not shared across replicas); for
// production use RedisBudgetStore. All mutations hold b.mu, so the budget check
// and the reservation are atomic and enforcement is concurrency-safe.
type MemBudgetStore struct {
	mu     sync.Mutex
	spend  map[string]float64 // key → month-to-date reserved+committed USD
	month  string             // accounting month "YYYY-MM"
	rates  map[string][]int64 // key → unix-second timestamps (sliding window)
	limits map[string]*VirtualKey
}

// NewBudgetStore returns an in-memory BudgetStore seeded from the provided
// virtual keys. This is the default when no Redis address is configured.
func NewBudgetStore(keys []VirtualKey) *MemBudgetStore {
	limits := make(map[string]*VirtualKey, len(keys))
	for i := range keys {
		limits[keys[i].KeyID] = &keys[i]
	}
	return &MemBudgetStore{
		spend:  map[string]float64{},
		month:  time.Now().UTC().Format("2006-01"),
		rates:  map[string][]int64{},
		limits: limits,
	}
}

func (b *MemBudgetStore) rollMonthLocked() {
	m := time.Now().UTC().Format("2006-01")
	if m != b.month {
		b.month = m
		b.spend = map[string]float64{}
	}
}

// Reserve enforces budget + rate limit and holds the estimate, atomically.
func (b *MemBudgetStore) Reserve(vk *VirtualKey, est float64) (*BudgetReservation, bool, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollMonthLocked()

	// 1. Monthly budget: reject only when already at/over the cap. Because the
	// hold is added below under the same lock, N concurrent reservers can exceed
	// the cap by at most one hold (the last admitted before the cap was crossed).
	if vk.MonthlyBudget > 0 && b.spend[vk.KeyID] >= vk.MonthlyBudget {
		return nil, false, "monthly_budget_exceeded"
	}

	// 2. Rate limit (sliding window) — record a slot only when within the limit.
	if vk.RateLimitRPM > 0 {
		now := time.Now().Unix()
		cutoff := now - 60
		ts := b.rates[vk.KeyID]
		i := 0
		for ; i < len(ts) && ts[i] < cutoff; i++ {
		}
		ts = ts[i:]
		if len(ts) >= vk.RateLimitRPM {
			b.rates[vk.KeyID] = ts
			return nil, false, "rate_limit_exceeded"
		}
		b.rates[vk.KeyID] = append(ts, now)
	}

	// 3. Hold the estimate.
	if est < 0 {
		est = 0
	}
	b.spend[vk.KeyID] += est
	return &BudgetReservation{keyID: vk.KeyID, month: b.month, amount: est}, true, ""
}

// Commit adjusts the held estimate to the realized cost.
func (b *MemBudgetStore) Commit(res *BudgetReservation, actual float64) {
	if res == nil || res.noop {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if res.applied {
		return
	}
	res.applied = true
	b.rollMonthLocked()
	if actual < 0 {
		actual = 0
	}
	if b.month == res.month {
		b.spend[res.keyID] += actual - res.amount
		if b.spend[res.keyID] < 0 {
			b.spend[res.keyID] = 0
		}
	} else {
		// Month rolled since Reserve — the held bucket was reset; book the actual.
		b.spend[res.keyID] += actual
	}
}

// Release returns the held estimate in full.
func (b *MemBudgetStore) Release(res *BudgetReservation) {
	if res == nil || res.noop {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if res.applied {
		return
	}
	res.applied = true
	b.rollMonthLocked()
	if b.month == res.month {
		b.spend[res.keyID] -= res.amount
		if b.spend[res.keyID] < 0 {
			b.spend[res.keyID] = 0
		}
	}
}

// Snapshot returns the current spend state for the /v1/usage endpoint.
func (b *MemBudgetStore) Snapshot() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make(map[string]float64, len(b.spend))
	for k, v := range b.spend {
		// Expose a redacted key id only — never the plaintext bearer token.
		out[redactKey(k)] += v
	}
	return map[string]any{"month": b.month, "spend_usd_by_key": out}
}

// Close is a no-op for the in-memory store.
func (b *MemBudgetStore) Close() error { return nil }
