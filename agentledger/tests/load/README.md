# Load tests (P6-F1)

Advisory load tests — run manually (`make load`) or via the nightly
`load-nightly` workflow. **Not** a blocking PR gate: 1k RPS on shared CI runners
is too noisy to gate merges on.

## Gateway policy overhead (`gateway.k6.js`)

Proves the CLAUDE.md budget: **gateway inline policy overhead p95 < 75ms at ~1k
RPS**. "Policy overhead" is the gateway's own auth → model-allowlist →
tool-governance → budget → DLP path, *excluding* the upstream round-trip. The
gateway measures it directly in `gateway_policy_overhead_ms` (a Prometheus
histogram on `GET /metrics`); the k6 run scrapes it in teardown.

### Setup

1. **Mock upstream** — point the gateway at a near-zero-latency OpenAI-compatible
   responder so end-to-end latency reflects gateway overhead, not a real model.
   Any static 200-returning server works (e.g. a tiny Go/Node stub or
   `mockUpstream` from the gateway tests). Configure it as the provider `base_url`
   in the gateway config, and seed a virtual key (default `alk_loadtest`).
2. **Run:**
   ```sh
   make load                          # localhost:8080, key alk_loadtest, 1000 RPS, 30s
   GATEWAY_URL=https://gw.staging RPS=1500 DURATION=60s \
     GATEWAY_KEY=alk_xxx k6 run tests/load/gateway.k6.js
   ```
3. **Read the result:** k6 fails the run if `http_req_duration` p95 ≥ 75ms or the
   error rate ≥ 1%. The teardown log prints the authoritative
   `gateway_policy_overhead_ms` buckets/sum/count straight from the gateway.

Env knobs: `GATEWAY_URL`, `GATEWAY_KEY`, `RPS`, `DURATION`.

## ClickHouse ingest capacity (50M events/day)

CLAUDE.md also targets **ClickHouse capacity at 50M events/day** (≈ 580 events/s
sustained). Drive it through the real ingest path — POST batched canonical
`llm_call` events to the collector (`/v1/events`), which produces to Redpanda and
the `ch-insert` worker batch-inserts to ClickHouse — and watch consumer lag +
`chinsert_rows_inserted_total`. A direct `INSERT … FORMAT JSONEachRow` batch loop
against ClickHouse is the lower-bound check. Sustained throughput ≥ 580 rows/s
with stable lag passes. (Scripted harness deferred; documented here so the target
is explicit — see ADR-037.)
