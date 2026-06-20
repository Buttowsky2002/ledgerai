package main

import (
	"os"
	"strconv"
	"strings"
)

// Config is the collector's environment-driven configuration. The collector
// has no static config file: it is a stateless ingest service, so everything
// comes from the environment (12-factor; secrets are never read from files).
type Config struct {
	ListenAddr   string   // AGENTLEDGER_COLLECTOR_ADDR (default :8090)
	Brokers      []string // AGENTLEDGER_KAFKA_BROKERS (csv, default localhost:19092)
	Topic        string   // AGENTLEDGER_KAFKA_TOPIC (default events.raw)
	SchemaPath   string   // AGENTLEDGER_EVENT_SCHEMA (default ../../schemas/events/llm_call.schema.json)
	MaxBodyBytes int64    // AGENTLEDGER_MAX_BODY_BYTES (default 4 MiB)
	MaxBatch     int      // AGENTLEDGER_MAX_BATCH (max events per request, default 1000)
	MaxInflight  int      // AGENTLEDGER_MAX_INFLIGHT (backpressure gate, default 8192)

	// OTel GenAI ingestion (gateway-agnostic source, ARCHITECTURE_PIVOT.md P1).
	OtelTenantAttr    string // AGENTLEDGER_OTEL_TENANT_ATTR (resource/span attr carrying tenant; default agentledger.tenant_id)
	OtelDefaultTenant string // AGENTLEDGER_OTEL_DEFAULT_TENANT (fallback when no attr/header; empty = require explicit tenant)
}

// LoadConfig reads the collector configuration from environment variables,
// applying defaults for any unset values.
func LoadConfig() Config {
	return Config{
		ListenAddr:   env("AGENTLEDGER_COLLECTOR_ADDR", ":8090"),
		Brokers:      splitCSV(env("AGENTLEDGER_KAFKA_BROKERS", "localhost:19092")),
		Topic:        env("AGENTLEDGER_KAFKA_TOPIC", "events.raw"),
		SchemaPath:   env("AGENTLEDGER_EVENT_SCHEMA", "../../schemas/events/llm_call.schema.json"),
		MaxBodyBytes: envInt64("AGENTLEDGER_MAX_BODY_BYTES", 4<<20),
		MaxBatch:     int(envInt64("AGENTLEDGER_MAX_BATCH", 1000)),
		MaxInflight:  int(envInt64("AGENTLEDGER_MAX_INFLIGHT", 8192)),

		OtelTenantAttr:    env("AGENTLEDGER_OTEL_TENANT_ATTR", otelTenantAttrDefault),
		OtelDefaultTenant: os.Getenv("AGENTLEDGER_OTEL_DEFAULT_TENANT"),
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt64(key string, def int64) int64 {
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
