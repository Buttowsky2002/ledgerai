package chinsert

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the ch-insert worker's environment-driven configuration.
type Config struct {
	Brokers       []string // BADGERIQ_KAFKA_BROKERS (csv)
	Topic         string   // BADGERIQ_KAFKA_TOPIC (events.raw)
	DLQTopic      string   // BADGERIQ_KAFKA_DLQ_TOPIC (events.dlq)
	ConsumerGroup string   // BADGERIQ_CONSUMER_GROUP (ch-insert)

	ClickHouseURL      string // BADGERIQ_CLICKHOUSE_URL (http://localhost:8123)
	ClickHouseDB       string // BADGERIQ_CLICKHOUSE_DB (agentledger)
	ClickHouseUser     string // BADGERIQ_CLICKHOUSE_USER (default)
	ClickHousePassword string // BADGERIQ_CLICKHOUSE_PASSWORD (secret, from env)

	ListenAddr    string        // BADGERIQ_WORKER_ADDR (:8091) — health/metrics
	InsertRetries int           // BADGERIQ_INSERT_RETRIES (3)
	RetryBackoff  time.Duration // BADGERIQ_RETRY_BACKOFF_MS (250ms)
}

// LoadConfig reads the ch-insert worker configuration from environment
// variables, applying defaults for any unset values.
func LoadConfig() Config {
	return Config{
		Brokers:            splitCSV(env("BADGERIQ_KAFKA_BROKERS", "localhost:19092")),
		Topic:              env("BADGERIQ_KAFKA_TOPIC", "events.raw"),
		DLQTopic:           env("BADGERIQ_KAFKA_DLQ_TOPIC", "events.dlq"),
		ConsumerGroup:      env("BADGERIQ_CONSUMER_GROUP", "ch-insert"),
		ClickHouseURL:      env("BADGERIQ_CLICKHOUSE_URL", "http://localhost:8123"),
		ClickHouseDB:       env("BADGERIQ_CLICKHOUSE_DB", "agentledger"),
		ClickHouseUser:     env("BADGERIQ_CLICKHOUSE_USER", "default"),
		ClickHousePassword: lookupEnv("BADGERIQ_CLICKHOUSE_PASSWORD"),
		ListenAddr:         env("BADGERIQ_WORKER_ADDR", ":8091"),
		InsertRetries:      envIntLocal("BADGERIQ_INSERT_RETRIES", 3),
		RetryBackoff:       time.Duration(envInt("BADGERIQ_RETRY_BACKOFF_MS", 250)) * time.Millisecond,
	}
}

// lookupEnv resolves an environment variable, preferring BADGERIQ_* and falling back to LEDGERAI_*
// name and falling back to the legacy AGENTLEDGER_* alias (deprecated; kept for
// backwards compatibility — see the README "Renaming to BadgerIQ" note).
func lookupEnv(name string) string {
	const legacy = "AGENTLEDGER_"
	if len(name) > len(legacy) && name[:len(legacy)] == legacy {
		suffix := name[len(legacy):]
		if v := os.Getenv("BADGERIQ_" + suffix); v != "" {
			return v
		}
		if v := os.Getenv("LEDGERAI_" + suffix); v != "" {
			return v
		}
	}
	return os.Getenv(name)
}

func env(key, def string) string {
	if v := lookupEnv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int64) int64 {
	if v := lookupEnv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func envIntLocal(key string, def int) int {
	if v := lookupEnv(key); v != "" {
		n, err := strconv.ParseInt(v, 10, 0)
		if err == nil {
			return int(n)
		}
	}
	return def
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
