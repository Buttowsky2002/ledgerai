// Gateway policy-overhead load test (P6-F1, ADR-037).
//
// Proves the CLAUDE.md budget: gateway inline policy overhead p95 < 75ms at ~1k
// RPS. Point the gateway at a NEAR-ZERO-LATENCY mock upstream (see
// tests/load/README.md) so end-to-end latency is dominated by the gateway's own
// auth → policy → budget → DLP → tool-governance path. The authoritative overhead
// figure is the gateway's own `gateway_policy_overhead_ms` histogram, scraped from
// /metrics in teardown; http_req_duration is the end-to-end cross-check.
//
// Advisory only — run via `make load` or the nightly workflow, never a blocking
// PR gate (1k RPS on shared CI runners is too noisy to gate on).
import http from 'k6/http';
import { check } from 'k6';

const GATEWAY = __ENV.GATEWAY_URL || 'http://localhost:8080';
const KEY = __ENV.GATEWAY_KEY || 'alk_loadtest';
const RPS = Number(__ENV.RPS || 1000);
const DURATION = __ENV.DURATION || '30s';

export const options = {
  scenarios: {
    policy_overhead: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 200,
      maxVUs: 2000,
    },
  },
  thresholds: {
    // With a ~0ms mock upstream, end-to-end p95 ≈ policy overhead. The gateway's
    // own histogram (teardown) is authoritative; this is the load-side guardrail.
    http_req_duration: ['p(95)<75'],
    http_req_failed: ['rate<0.01'],
  },
};

const body = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'ping' }] });
const params = { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` } };

export default function () {
  const res = http.post(`${GATEWAY}/v1/chat/completions`, body, params);
  check(res, { 'status is 200': (r) => r.status === 200 });
}

// Print the gateway's own policy-overhead histogram + request counters so the
// operator sees the authoritative inline overhead (independent of upstream time).
export function teardown() {
  const res = http.get(`${GATEWAY}/metrics`);
  if (res.status !== 200) {
    console.log(`could not scrape ${GATEWAY}/metrics (status ${res.status})`);
    return;
  }
  const lines = res.body
    .split('\n')
    .filter((l) => l.startsWith('gateway_policy_overhead_ms') || l.startsWith('gateway_requests_total'));
  console.log('--- gateway /metrics (authoritative policy overhead) ---\n' + lines.join('\n'));
}
