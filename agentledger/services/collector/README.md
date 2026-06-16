# Collector

HTTP ingest service for AgentLedger events. Validates incoming SDK and gateway
events against the canonical schema and produces them to the event bus
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

| Method / path      | Purpose                                                            |
|--------------------|--------------------------------------------------------------------|
| `POST /v1/events`  | Ingest one event, a JSON array, or NDJSON. See status codes below. |
| `GET /healthz`     | Liveness.                                                          |
| `GET /readyz`      | Readiness — pings the event bus.                                   |
| `GET /metrics`     | Prometheus text exposition.                                        |

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

## Design

See `docs/ADRs/005-ingest-collector.md` for the Kafka-client choice, the
non-blocking backpressure model, and the schema-as-security-boundary decision.
