package main

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// SpendDrainFn is called periodically with month-to-date spend per virtual key.
// Phase 1: logs to slog. Phase 3: wired to the control-plane Postgres connection
// for the monthly-close workflow (budget reconciliation against provider billing).
type SpendDrainFn func(virtualKey, month string, spendUSD float64)

// RedisBudgetStore implements BudgetStore using Redis for cross-replica
// consistency and restart durability.
//
// Redis key layout (prefix "al:"):
//
//	al:budget:{virtualKey}:{YYYY-MM}  — INCRBYFLOAT month-to-date spend (USD)
//	al:rate:{virtualKey}              — ZSET sliding-window rate limiter
//
// Budget keys expire 7 days after month-end (reconciliation window).
// Rate-limit keys expire after 70 s (60 s window + 10 s buffer).
type RedisBudgetStore struct {
	rdb    *redis.Client
	limits map[string]*VirtualKey

	drainFn   SpendDrainFn
	stopCh    chan struct{}
	drainDone sync.WaitGroup
}

// rateSeq is a process-local counter ensuring unique ZSET members across
// concurrent requests that arrive within the same nanosecond.
var rateSeq atomic.Int64

// rateLimitScript atomically checks and records a rate-limit slot.
// Returns 1 if the request is within the limit, 0 if it is rate-limited.
//
// Uses redis.call('TIME') for server-side time so that the sliding window
// is consistent across replicas (no client clock skew) and advances correctly
// with miniredis FastForward in tests.
//
// KEYS[1]  — rate key  (al:rate:{virtualKey})
// ARGV[1]  — window size in seconds (60)
// ARGV[2]  — requests-per-minute limit
// ARGV[3]  — unique member ID for this request
var rateLimitScript = redis.NewScript(`
local key    = KEYS[1]
local window = tonumber(ARGV[1])
local limit  = tonumber(ARGV[2])
local member = ARGV[3]

local t   = redis.call('TIME')
local now = tonumber(t[1]) + tonumber(t[2]) / 1000000

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if tonumber(count) >= tonumber(limit) then
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, window + 10)
return 1
`)

// NewRedisBudgetStore dials Redis and returns a ready RedisBudgetStore.
//
//   - addr        — "host:port"
//   - password    — auth password (empty = no auth); callers derive this from
//     os.Getenv(cfg.Redis.PasswordEnv) — never inline in config
//   - db          — Redis DB index (0 = default)
//   - keys        — virtual keys for limit enforcement
//   - drainFn     — called every 5 min with MTD spend; nil disables draining
func NewRedisBudgetStore(addr, password string, db int, keys []VirtualKey, drainFn SpendDrainFn) (*RedisBudgetStore, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr:         addr,
		Password:     password,
		DB:           db,
		DialTimeout:  2 * time.Second,
		ReadTimeout:  500 * time.Millisecond,
		WriteTimeout: 500 * time.Millisecond,
		PoolSize:     16,
		MinIdleConns: 4,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		return nil, fmt.Errorf("redis connect %s: %w", addr, err)
	}

	limits := make(map[string]*VirtualKey, len(keys))
	for i := range keys {
		limits[keys[i].Key] = &keys[i]
	}

	s := &RedisBudgetStore{
		rdb:     rdb,
		limits:  limits,
		drainFn: drainFn,
		stopCh:  make(chan struct{}),
	}

	if drainFn != nil {
		s.drainDone.Add(1)
		go s.drainLoop()
	}

	return s, nil
}

// CheckAndCount enforces monthly budget and per-minute rate limit pre-flight.
//
// Budget check is a single GET (no atomic increment — AddSpend handles that
// post-flight once cost is known). Rate-limit check-and-record uses a Lua
// script for atomicity. Both operations fail-open: a Redis error yields
// (true, "") with a slog.Warn — the gateway keeps serving and the provider
// billing reconciliation backstops cost accuracy.
func (s *RedisBudgetStore) CheckAndCount(vk *VirtualKey) (bool, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	// 1. Monthly budget check.
	if vk.MonthlyBudget > 0 {
		month := time.Now().UTC().Format("2006-01")
		val, err := s.rdb.Get(ctx, budgetKey(vk.Key, month)).Float64()
		if err != nil && err != redis.Nil {
			slog.Warn("budget check redis error — failing open", "key", vk.Key, "err", err)
		} else if val >= vk.MonthlyBudget {
			return false, "monthly_budget_exceeded"
		}
	}

	// 2. Rate-limit check-and-record (atomic Lua script, server-side time).
	if vk.RateLimitRPM > 0 {
		member := strconv.FormatInt(time.Now().UnixNano(), 10) + "." +
			strconv.FormatInt(rateSeq.Add(1), 10)

		res, err := rateLimitScript.Run(ctx, s.rdb,
			[]string{rateKey(vk.Key)},
			60.0, vk.RateLimitRPM, member,
		).Int()
		if err != nil {
			slog.Warn("rate limit redis error — failing open", "key", vk.Key, "err", err)
		} else if res == 0 {
			return false, "rate_limit_exceeded"
		}
	}

	return true, ""
}

// AddSpend records realized cost post-flight using INCRBYFLOAT.
// ExpireNX sets the TTL on first write (no-op on subsequent writes within
// the same month), ensuring the key expires for the reconciliation window.
func (s *RedisBudgetStore) AddSpend(key string, usd float64) {
	if usd == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	now := time.Now().UTC()
	bKey := budgetKey(key, now.Format("2006-01"))

	pipe := s.rdb.Pipeline()
	pipe.IncrByFloat(ctx, bKey, usd)
	pipe.ExpireNX(ctx, bKey, monthKeyTTL(now))
	if _, err := pipe.Exec(ctx); err != nil {
		slog.Warn("spend increment failed", "key", key, "usd", usd, "err", err)
	}
}

// Snapshot scans budget keys for the current month and returns MTD spend
// for the /v1/usage debug endpoint. This is the only BudgetStore method
// that does a full Redis scan; it is called only on the ops endpoint.
func (s *RedisBudgetStore) Snapshot() map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	month := time.Now().UTC().Format("2006-01")
	spend := map[string]float64{}

	var cursor uint64
	for {
		keys, next, err := s.rdb.Scan(ctx, cursor, "al:budget:*:"+month, 100).Result()
		if err != nil {
			slog.Warn("snapshot scan failed", "err", err)
			break
		}
		for _, k := range keys {
			val, err := s.rdb.Get(ctx, k).Float64()
			if err != nil {
				continue
			}
			// key = al:budget:{virtualKey}:{YYYY-MM}
			parts := strings.SplitN(k, ":", 4)
			if len(parts) == 4 {
				spend[parts[2]] = val
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	return map[string]any{"month": month, "spend_usd_by_key": spend}
}

// Close stops the drain goroutine (with one final drain pass) and closes
// the Redis client connection pool.
func (s *RedisBudgetStore) Close() error {
	close(s.stopCh)
	s.drainDone.Wait()
	return s.rdb.Close()
}

// drainLoop fires every 5 minutes and once on shutdown. It calls drainFn
// with the MTD spend for every budget key, enabling the caller to persist
// counters for the monthly-close workflow.
func (s *RedisBudgetStore) drainLoop() {
	defer s.drainDone.Done()
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			s.runDrain()
		case <-s.stopCh:
			s.runDrain()
			return
		}
	}
}

func (s *RedisBudgetStore) runDrain() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var cursor uint64
	for {
		keys, next, err := s.rdb.Scan(ctx, cursor, "al:budget:*", 100).Result()
		if err != nil {
			slog.Error("budget drain scan failed", "err", err)
			return
		}
		for _, k := range keys {
			val, err := s.rdb.Get(ctx, k).Float64()
			if err != nil {
				continue
			}
			// key = al:budget:{virtualKey}:{YYYY-MM}
			parts := strings.SplitN(k, ":", 4)
			if len(parts) == 4 {
				s.drainFn(parts[2], parts[3], val)
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
}

// ---------- key helpers ----------

func budgetKey(virtualKey, month string) string {
	return "al:budget:" + virtualKey + ":" + month
}

func rateKey(virtualKey string) string {
	return "al:rate:" + virtualKey
}

// monthKeyTTL returns the duration from t until 7 days after the end of
// t's calendar month. Budget keys are kept 7 days post-month-end for the
// provider reconciliation window before Redis expires them.
func monthKeyTTL(t time.Time) time.Duration {
	nextMonth := time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, time.UTC)
	return nextMonth.Sub(t) + 7*24*time.Hour
}
