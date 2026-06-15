package main

import (
	"sync"
	"time"
)

// BudgetStore is the spend-tracking and rate-limit enforcement contract.
// Two implementations ship: MemBudgetStore (single-process, ephemeral,
// zero-deps) and RedisBudgetStore (shared across replicas, restart-durable).
// Select at startup via Config.Redis.Addr: empty → mem, non-empty → redis.
type BudgetStore interface {
	// CheckAndCount enforces the monthly budget and per-minute rate limit
	// pre-flight. Returns (true, "") on success or (false, reason) on reject.
	CheckAndCount(vk *VirtualKey) (bool, string)

	// AddSpend records realized cost post-flight, after the upstream responds.
	AddSpend(key string, usd float64)

	// Snapshot returns current MTD spend for the /v1/usage debug endpoint.
	Snapshot() map[string]any

	// Close flushes pending drains and releases connection pools / goroutines.
	Close() error
}

// MemBudgetStore is the in-process BudgetStore implementation.
// Counters are per-process and ephemeral: they reset on restart and are not
// shared across gateway replicas. For production use RedisBudgetStore.
type MemBudgetStore struct {
	mu     sync.Mutex
	spend  map[string]float64 // key → month-to-date USD
	month  string             // accounting month "YYYY-MM"
	rates  map[string][]int64 // key → unix-second timestamps (sliding window)
	limits map[string]*VirtualKey
}

// NewBudgetStore returns an in-memory BudgetStore seeded from the provided
// virtual keys. This is the default when no Redis address is configured.
func NewBudgetStore(keys []VirtualKey) *MemBudgetStore {
	limits := make(map[string]*VirtualKey, len(keys))
	for i := range keys {
		limits[keys[i].Key] = &keys[i]
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

// CheckAndCount enforces budget and rate limit pre-flight. Caller holds no lock.
func (b *MemBudgetStore) CheckAndCount(vk *VirtualKey) (bool, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollMonthLocked()

	if vk.MonthlyBudget > 0 && b.spend[vk.Key] >= vk.MonthlyBudget {
		return false, "monthly_budget_exceeded"
	}
	if vk.RateLimitRPM > 0 {
		now := time.Now().Unix()
		cutoff := now - 60
		ts := b.rates[vk.Key]
		i := 0
		for ; i < len(ts) && ts[i] < cutoff; i++ {
		}
		ts = ts[i:]
		if len(ts) >= vk.RateLimitRPM {
			b.rates[vk.Key] = ts
			return false, "rate_limit_exceeded"
		}
		b.rates[vk.Key] = append(ts, now)
	}
	return true, ""
}

// AddSpend records realized cost after the call completes.
func (b *MemBudgetStore) AddSpend(key string, usd float64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollMonthLocked()
	b.spend[key] += usd
}

// Snapshot returns the current spend state for the /v1/usage endpoint.
func (b *MemBudgetStore) Snapshot() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make(map[string]float64, len(b.spend))
	for k, v := range b.spend {
		out[k] = v
	}
	return map[string]any{"month": b.month, "spend_usd_by_key": out}
}

// Close is a no-op for the in-memory store.
func (b *MemBudgetStore) Close() error { return nil }
