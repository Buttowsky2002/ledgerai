# Collector

HTTP ingest service for AgentLedger events — the gateway-agnostic **front door**
(ARCHITECTURE_PIVOT.md, Pillar 1). Validates incoming SDK, gateway, and OTel
GenAI telemetry against the canonical schema and produces it to the event bus
(Redpanda topic `events.raw`), keyed by tenant. The collector is stateless,
horizontally scalable, and never blocks the caller — durability lives in the bus.

## Pipeline position

```
SDK / gateway  ──HTTP──▶  collector  ──Kafka──▶  events.raw  ──▶  CH insert worker  ──▶  ClickHouse
                         (validate)             (Redpanda)        (Phase 1 task 5)
```

## Run

```bash
cd services/collector
go run .                       # listens on :8090, produces to localhost:19092

# send an event
curl -i http://localhost:8090/v1/events \
  -H 'Content-Type: application/json' \
  -d '{"call_id":"c1","ts":"2026-06-16T12:00:00Z","tenant_id":"t1","provider":"openai","request_model":"gpt-4o","input_tokens":10,"output_tokens":5,"cost_usd":0.001,"status":"ok"}'
# → HTTP 202  {"accepted":1,"rejected_validation":0,"rejected_backpressure":0}
```

Point the **gateway** event sink at the collector by setting its config
`events.type=http`, `events.url=http://collector:8090/v1/events`. The **SDK**
posts here via its `collector_url`.

## Endpoints

| Method / path          | Purpose                                                                  |
|------------------------|--------------------------------------------------------------------------|
| `POST /v1/events`      | Ingest one event, a JSON array, or NDJSON. See status codes below.       |
| `POST /v1/ingest/otel` | Ingest OTLP/JSON traces; maps `gen_ai.*` spans to canonical events.      |
| `GET /healthz`         | Liveness.                                                                |
| `GET /readyz`          | Readiness — pings the event bus.                                         |
| `GET /metrics`         | Prometheus text exposition.                                              |

### `POST /v1/ingest/otel` — OTel GenAI

Accepts an OTLP/JSON `ExportTraceServiceRequest`. Spans carrying GenAI markers
(`gen_ai.system` / `gen_ai.request.model` / `gen_ai.operation.name`) are mapped
to canonical `llm_call` events (`source:"otel"`); other spans are skipped. This
lets any stack already emitting `gen_ai.*` spans (OpenLLMetry, Langfuse,
Datadog, raw OTel SDK) stream telemetry in without code changes.

```bash
curl -i http://localhost:8090/v1/ingest/otel \
  -H 'Content-Type: application/json' \
  -H 'X-AgentLedger-Tenant: t1' \
  -d '{"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"spans":[
       {"spanId":"s1","name":"chat","startTimeUnixNano":"1718800000000000000",
        "endTimeUnixNano":"1718800001000000000","attributes":[
          {"key":"gen_ai.system","value":{"stringValue":"openai"}},
          {"key":"gen_ai.request.model","value":{"stringValue":"gpt-4o"}},
          {"key":"gen_ai.usage.input_tokens","value":{"intValue":"10"}},
          {"key":"gen_ai.usage.output_tokens","value":{"intValue":"5"}}]}]}]}]}'
# → HTTP 200  {"accepted":1,"rejected_validation":0,"rejected_backpressure":0,"spans_skipped":0}
```

Returns 200 on any successful conversion, 429 on pure backpressure, 400 on an
unparseable body. **Tenant** is resolved from the span/resource attribute named
by `AGENTLEDGER_OTEL_TENANT_ATTR` (default `agentledger.tenant_id`), then the
`X-AgentLedger-Tenant` header, then `AGENTLEDGER_OTEL_DEFAULT_TENANT`; a GenAI
span with no resolvable tenant is dropped, never produced. Mapping details and
format assumptions: `docs/ADRs/022-otel-genai-ingestion.md`.

### `POST /v1/events` status codes

| Code | Meaning                                                        |
|------|---------------------------------------------------------------|
| 202  | At least one event accepted and enqueued for delivery.        |
| 429  | Producer at capacity (backpressure). Retry later. Never blocks.|
| 422  | Events parsed but all failed schema validation.               |
| 400  | Body could not be parsed / was empty.                         |
| 413  | Body exceeded the size limit, or too many events in a batch.  |

The response body summarizes `{accepted, rejected_validation, rejected_backpressure}`.

## Validation

`llm_call` events (the only canonical event in Phase 1) are validated against
`schemas/events/llm_call.schema.json`. The schema sets `additionalProperties:
false`, so an event carrying a raw prompt/completion field is **rejected at the
boundary** — raw content can never enter the analytics pipeline (CLAUDE.md
rule 2). Other SDK event kinds (`agent_run`, `outcome`, `tool_call`) pass a
minimal envelope check pending their own schemas; unknown kinds are rejected.

## Environment variables

| Variable                      | Default                                          | Purpose                              |
|-------------------------------|--------------------------------------------------|--------------------------------------|
| `AGENTLEDGER_COLLECTOR_ADDR`  | `:8090`                                          | HTTP listen address.                 |
| `AGENTLEDGER_KAFKA_BROKERS`   | `localhost:19092`                                | Comma-separated broker list.         |
| `AGENTLEDGER_KAFKA_TOPIC`     | `events.raw`                                     | Target topic.                        |
| `AGENTLEDGER_EVENT_SCHEMA`    | `../../schemas/events/llm_call.schema.json`      | Path to the canonical schema.        |
| `AGENTLEDGER_MAX_BODY_BYTES`  | `4194304` (4 MiB)                                | Request body size limit.             |
| `AGENTLEDGER_MAX_BATCH`       | `1000`                                           | Max events per request.              |
| `AGENTLEDGER_MAX_INFLIGHT`    | `8192`                                           | Backpressure gate (in-flight records).|
| `AGENTLEDGER_OTEL_TENANT_ATTR`| `agentledger.tenant_id`                          | OTel span/resource attr carrying the tenant.|
| `AGENTLEDGER_OTEL_DEFAULT_TENANT`| _(empty)_                                     | Fallback tenant when no attr/header (empty = require explicit).|

## Design

See `docs/ADRs/005-ingest-collector.md` for the Kafka-client choice, the
non-blocking backpressure model, and the schema-as-security-boundary decision.
