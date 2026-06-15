package main

import (
	"sync"
	"time"
)

// ---------- Virtual key store ----------

type KeyStore struct {
	mu   sync.RWMutex
	keys map[string]*VirtualKey
}

func NewKeyStore(keys []VirtualKey) *KeyStore {
	m := make(map[string]*VirtualKey, len(keys))
	for i := range keys {
		m[keys[i].Key] = &keys[i]
	}
	return &KeyStore{keys: m}
}

func (s *KeyStore) Lookup(key string) (*VirtualKey, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	vk, ok := s.keys[key]
	return vk, ok
}

// ---------- Budget + rate limit store ----------
//
// MVP: in-memory, per-process. Production: backed by Redis with
// async drain to Postgres so budgets survive restarts and are shared
// across gateway replicas. The interface stays identical.

type BudgetStore struct {
	mu     sync.Mutex
	spend  map[string]float64 // key -> month-to-date USD
	month  string             // current accounting month "2026-06"
	rates  map[string][]int64 // key -> request unix-second timestamps (sliding window)
	limits map[string]*VirtualKey
}

func NewBudgetStore(keys []VirtualKey) *BudgetStore {
	limits := make(map[string]*VirtualKey, len(keys))
	for i := range keys {
		limits[keys[i].Key] = &keys[i]
	}
	return &BudgetStore{
		spend:  map[string]float64{},
		month:  time.Now().UTC().Format("2006-01"),
		rates:  map[string][]int64{},
		limits: limits,
	}
}

func (b *BudgetStore) rollMonthLocked() {
	m := time.Now().UTC().Format("2006-01")
	if m != b.month {
		b.month = m
		b.spend = map[string]float64{}
	}
}

// CheckAndCount returns (allowed, reason). It enforces rate limit and
// monthly budget *before* the upstream call using current spend.
func (b *BudgetStore) CheckAndCount(vk *VirtualKey) (bool, string) {
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
		// drop timestamps outside the window
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
func (b *BudgetStore) AddSpend(key string, usd float64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollMonthLocked()
	b.spend[key] += usd
}

func (b *BudgetStore) Snapshot() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := map[string]float64{}
	for k, v := range b.spend {
		out[k] = v
	}
	return map[string]any{"month": b.month, "spend_usd_by_key": out}
}
