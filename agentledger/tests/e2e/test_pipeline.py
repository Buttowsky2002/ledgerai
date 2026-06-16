#!/usr/bin/env python3
"""End-to-end Phase 1 acceptance test.

Proves the ingest pipeline end to end:

    SDK  ──▶  collector  ──▶  Redpanda (events.raw)  ──▶  ch-insert  ──▶  ClickHouse

A unique tenant id is generated per run; the test emits an SDK llm_call event
for that tenant, then polls ClickHouse until the row materializes.

Prerequisites — bring the stack up first:

    docker compose up -d postgres clickhouse redpanda collector ch-insert

Run:

    python3 tests/e2e/test_pipeline.py

Environment overrides: COLLECTOR_URL (http://localhost:8090),
CLICKHOUSE_URL (http://localhost:8123).
"""
from __future__ import annotations

import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "packages", "sdk-python"))

import agentledger as al  # noqa: E402

COLLECTOR_URL = os.getenv("COLLECTOR_URL", "http://localhost:8090")
CLICKHOUSE_URL = os.getenv("CLICKHOUSE_URL", "http://localhost:8123")


def ch_query(sql: str) -> str:
    url = CLICKHOUSE_URL + "/?query=" + urllib.parse.quote(sql)
    with urllib.request.urlopen(url, timeout=5) as r:  # noqa: S310 (local dev URL)
        return r.read().decode().strip()


def wait_http(url: str, timeout: float = 60.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as r:  # noqa: S310
                if r.status < 500:
                    return True
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(1)
    return False


def main() -> int:
    print(f"waiting for collector at {COLLECTOR_URL} ...")
    if not wait_http(COLLECTOR_URL + "/healthz"):
        print("FAIL: collector not reachable — is the stack up?")
        return 1
    print(f"waiting for clickhouse at {CLICKHOUSE_URL} ...")
    if not wait_http(CLICKHOUSE_URL + "/ping"):
        print("FAIL: clickhouse not reachable — is the stack up?")
        return 1

    tenant = f"e2e_{uuid.uuid4().hex[:12]}"
    print(f"emitting SDK event for tenant {tenant} ...")

    al.init(collector_url=COLLECTOR_URL + "/v1/events", tenant_id=tenant,
            app_id="e2e", user_id="e2e@test")
    with al.run(agent_id="e2e-agent", objective="pipeline acceptance") as run:
        run.record_llm_call(provider="openai", model="gpt-4o",
                            input_tokens=10, output_tokens=5, cost_usd=0.001,
                            cache_read_tokens=2)

    print("polling clickhouse for the row ...")
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            n = ch_query(
                f"SELECT count() FROM agentledger.llm_calls WHERE tenant_id='{tenant}'")
        except (urllib.error.URLError, OSError) as exc:
            print(f"  query error (retrying): {exc}")
            n = "0"
        if n.isdigit() and int(n) >= 1:
            cost = ch_query(
                f"SELECT sum(cost_usd) FROM agentledger.llm_calls WHERE tenant_id='{tenant}'")
            print(f"PASS: row landed in ClickHouse (count={n}, cost_usd={cost})")
            return 0
        time.sleep(1)

    print("FAIL: event never reached ClickHouse within 30s")
    return 1


if __name__ == "__main__":
    sys.exit(main())
