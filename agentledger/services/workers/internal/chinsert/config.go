package chinsert

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the ch-insert worker's environment-driven configuration.
type Config struct {
	Brokers       []string // AGENTLEDGER_KAFKA_BROKERS (csv)
	Topic         string   // AGENTLEDGER_KAFKA_TOPIC (events.raw)
	DLQTopic      string   // AGENTLEDGER_KAFKA_DLQ_TOPIC (events.dlq)
	ConsumerGroup string   // AGENTLEDGER_CONSUMER_GROUP (ch-insert)

	ClickHouseURL      string // AGENTLEDGER_CLICKHOUSE_URL (http://localhost:8123)
	ClickHouseDB       string // AGENTLEDGER_CLICKHOUSE_DB (agentledger)
	ClickHouseUser     string // AGENTLEDGER_CLICKHOUSE_USER (default)
	ClickHousePassword string // AGENTLEDGER_CLICKHOUSE_PASSWORD (secret, from env)

	ListenAddr    string        // AGENTLEDGER_WORKER_ADDR (:8091) — health/metrics
	InsertRetries int           // AGENTLEDGER_INSERT_RETRIES (3)
	RetryBackoff  time.Duration // AGENTLEDGER_RETRY_BACKOFF_MS (250ms)
}

// LoadConfig reads the ch-insert worker configuration from environment
// variables, applying defaults for any unset values.
func LoadConfig() Config {
	return Config{
		Brokers:            splitCSV(env("AGENTLEDGER_KAFKA_BROKERS", "localhost:19092")),
		Topic:              env("AGENTLEDGER_KAFKA_TOPIC", "events.raw"),
		DLQTopic:           env("AGENTLEDGER_KAFKA_DLQ_TOPIC", "events.dlq"),
		ConsumerGroup:      env("AGENTLEDGER_CONSUMER_GROUP", "ch-insert"),
		ClickHouseURL:      env("AGENTLEDGER_CLICKHOUSE_URL", "http://localhost:8123"),
		ClickHouseDB:       env("AGENTLEDGER_CLICKHOUSE_DB", "agentledger"),
		ClickHouseUser:     env("AGENTLEDGER_CLICKHOUSE_USER", "default"),
		ClickHousePassword: os.Getenv("AGENTLEDGER_CLICKHOUSE_PASSWORD"),
		ListenAddr:         env("AGENTLEDGER_WORKER_ADDR", ":8091"),
		InsertRetries:      int(envInt("AGENTLEDGER_INSERT_RETRIES", 3)),
		RetryBackoff:       time.Duration(envInt("AGENTLEDGER_RETRY_BACKOFF_MS", 250)) * time.Millisecond,
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
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
