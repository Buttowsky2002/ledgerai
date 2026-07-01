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
	ListenAddr   string   // BADGERIQ_COLLECTOR_ADDR (default :8090)
	Brokers      []string // BADGERIQ_KAFKA_BROKERS (csv, default localhost:19092)
	Topic        string   // BADGERIQ_KAFKA_TOPIC (default events.raw)
	SchemaPath   string   // BADGERIQ_EVENT_SCHEMA (default ../../schemas/events/llm_call.schema.json)
	MaxBodyBytes int64    // BADGERIQ_MAX_BODY_BYTES (default 4 MiB)
	MaxBatch     int      // BADGERIQ_MAX_BATCH (max events per request, default 1000)
	MaxInflight  int      // BADGERIQ_MAX_INFLIGHT (backpressure gate, default 8192)

	// OTel GenAI ingestion (gateway-agnostic source, ARCHITECTURE_PIVOT.md P1).
	OtelTenantAttr    string // BADGERIQ_OTEL_TENANT_ATTR (resource/span attr carrying tenant; default agentledger.tenant_id)
	OtelDefaultTenant string // BADGERIQ_OTEL_DEFAULT_TENANT (fallback when no attr/header; empty = require explicit tenant)
}

// LoadConfig reads the collector configuration from environment variables,
// applying defaults for any unset values.
func LoadConfig() Config {
	return Config{
		ListenAddr:   env("BADGERIQ_COLLECTOR_ADDR", ":8090"),
		Brokers:      splitCSV(env("BADGERIQ_KAFKA_BROKERS", "localhost:19092")),
		Topic:        env("BADGERIQ_KAFKA_TOPIC", "events.raw"),
		SchemaPath:   env("BADGERIQ_EVENT_SCHEMA", "../../schemas/events/llm_call.schema.json"),
		MaxBodyBytes: envInt64("BADGERIQ_MAX_BODY_BYTES", 4<<20),
		MaxBatch:     envIntLocal("BADGERIQ_MAX_BATCH", 1000),
		MaxInflight:  envIntLocal("BADGERIQ_MAX_INFLIGHT", 8192),

		OtelTenantAttr:    env("BADGERIQ_OTEL_TENANT_ATTR", otelTenantAttrDefault),
		OtelDefaultTenant: lookupEnv("BADGERIQ_OTEL_DEFAULT_TENANT"),
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

func envInt64(key string, def int64) int64 {
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
