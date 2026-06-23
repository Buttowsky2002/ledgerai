# Ingestion adapters

Normalizers that turn a **third-party gateway's spend/usage logs** into
LedgerAI canonical `llm_call` events, then forward them to the collector.
This is the gateway-agnostic front door (ARCHITECTURE_PIVOT.md, Pillar 1): a
customer already running LiteLLM/Bifrost/Portkey connects a source and sees
attribution + cost **without routing traffic through our gateway**.

```
LiteLLM (logging callback / spend logs)
        │  POST /ingest/litellm
        ▼
   litellm adapter  ──normalize──▶  canonical events  ──POST /v1/events──▶  collector
   (this module)                                                            (validate → Redpanda)
```

Each adapter is a thin, **stdlib-only** Go service: it normalizes and forwards.
The collector remains the single place that schema-validates and produces to
Redpanda, so untrusted third-party input is gated at one boundary (CLAUDE.md
rule 15). The adapter rejects records missing fields required for attribution
(stable id, start time, resolvable tenant) rather than inventing values.

## Layout

```
services/ingest/adapters/
├── cmd/litellm/         # LiteLLM spend-log webhook (this phase)
├── internal/litellm/    # LiteLLM → canonical mapping (format assumptions live here)
├── internal/forward/    # POST canonical events to the collector, 429-aware retry
└── Dockerfile           # ARG CMD selects the adapter binary (parameterized like connectors)
```

Future spend-log normalizers (Bifrost, Portkey, OpenRouter) add a `cmd/<name>`
and an `internal/<name>` package alongside these.

## LiteLLM adapter

Point LiteLLM's logging callback (or a job replaying its `/spend/logs`) at
`POST /ingest/litellm`. Accepts a single spend-log object or a JSON array.

```bash
cd services/ingest/adapters
AGENTLEDGER_ADAPTER_TENANT=t_demo \
AGENTLEDGER_COLLECTOR_URL=http://localhost:8090/v1/events \
go run ./cmd/litellm     # listens on :8097

curl -i http://localhost:8097/ingest/litellm \
  -H 'Content-Type: application/json' \
  -d '{"id":"abc-123","custom_llm_provider":"openai","model":"gpt-4o",
       "response_cost":0.0042,"prompt_tokens":120,"completion_tokens":35,
       "startTime":1718800000.0,"endTime":1718800001.5,"call_type":"acompletion"}'
# → HTTP 202  {"received":1,"normalized":1,"rejected":0,"forwarded":1}
```

### Field mapping (LiteLLM → canonical event)

| canonical          | LiteLLM field(s)                                              |
|--------------------|---------------------------------------------------------------|
| `call_id`          | `id` → `request_id`, prefixed `litellm:`                      |
| `ts` / `latency_ms`| `startTime` / `endTime − startTime` (ISO string or unix-secs) |
| `cost_usd`         | `response_cost` → `spend`                                     |
| `input_tokens`     | `prompt_tokens`                                               |
| `output_tokens`    | `completion_tokens`                                           |
| `cache_read_tokens`/`cache_write_tokens` | `cache_read_input_tokens` / `cache_creation_input_tokens` |
| `provider`         | `custom_llm_provider`                                        |
| `request_model`    | `model`                                                      |
| `operation_name`   | `call_type`                                                  |
| `status`           | `failure`/`error` → `upstream_error`; else `ok`             |
| `user_id`          | `end_user` → `user` → `metadata.user_api_key_user_id`        |
| `team_id`          | `metadata.user_api_key_team_id`                             |
| `app_id`           | `metadata.user_api_key_alias`                               |
| `virtual_key_id`   | `api_key` (already a hash in LiteLLM)                        |
| `source`           | constant `"adapter"`                                         |

### Tenant resolution

The adapter is usually deployed per tenant: set `AGENTLEDGER_ADAPTER_TENANT`.
For a multi-tenant LiteLLM, set a per-record override under the metadata key
named by `AGENTLEDGER_ADAPTER_TENANT_META_KEY` (default
`agentledger_tenant_id`). A record with no resolvable tenant is rejected.

## Environment variables

| Variable                             | Default                              | Purpose                                   |
|--------------------------------------|--------------------------------------|-------------------------------------------|
| `AGENTLEDGER_LITELLM_ADAPTER_ADDR`   | `:8097`                              | HTTP listen address.                      |
| `AGENTLEDGER_COLLECTOR_URL`          | `http://localhost:8090/v1/events`    | Collector ingest endpoint to forward to.  |
| `AGENTLEDGER_ADAPTER_TENANT`         | _(empty)_                            | Default tenant for records without an override. |
| `AGENTLEDGER_ADAPTER_TENANT_META_KEY`| `agentledger_tenant_id`              | Metadata key that overrides the tenant per record. |
| `AGENTLEDGER_MAX_BODY_BYTES`         | `8388608` (8 MiB)                    | Request body size limit.                  |

## Format drift

LiteLLM's payload shape changes across versions; the decoder is tolerant (cost
under `spend` **or** `response_cost`, timestamps as ISO string **or**
unix-seconds float) and assumptions are recorded in
`docs/ADRs/023-litellm-adapter.md`. When LiteLLM changes a field name, update
`internal/litellm` and its tests — never loosen the collector's schema.
