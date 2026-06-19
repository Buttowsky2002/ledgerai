#!/usr/bin/env python3
"""End-to-end acceptance for gateway-agnostic ingestion (Pivot Phase 1).

Proves the pivot's headline claim — "connect a source, see value" without our
gateway — for two third-party sources, each through the full pipeline:

    OTel gen_ai span ─▶ collector /v1/ingest/otel ─┐
                                                    ├▶ Redpanda ─▶ ch-insert ─▶ ClickHouse
    LiteLLM spend log ─▶ litellm-adapter ─▶ collector /v1/events ─┘

A unique tenant id per source per run isolates the assertions. For each source
we check the row materializes with the correct cost + attribution dims and the
right `source` provenance ('otel' / 'adapter').

Prerequisites — bring the stack up first (from agentledger/):

    docker compose up -d clickhouse redpanda collector ch-insert litellm-adapter

Run:

    python3 tests/e2e/test_ingestion_adapters.py

Environment overrides: COLLECTOR_URL (http://localhost:8090),
ADAPTER_URL (http://localhost:8097), CLICKHOUSE_URL (http://localhost:8123).
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

COLLECTOR_URL = os.getenv("COLLECTOR_URL", "http://localhost:8090")
ADAPTER_URL = os.getenv("ADAPTER_URL", "http://localhost:8097")
CLICKHOUSE_URL = os.getenv("CLICKHOUSE_URL", "http://localhost:8123")


def ch_query(sql: str) -> str:
    url = CLICKHOUSE_URL + "/?query=" + urllib.parse.quote(sql)
    with urllib.request.urlopen(url, timeout=5) as r:  # noqa: S310 (local dev URL)
        return r.read().decode().strip()


def post_json(url: str, payload, headers: dict | None = None) -> tuple[int, str]:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:  # noqa: S310
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


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


def poll_row(tenant: str, timeout: float = 30.0) -> dict | None:
    """Wait for the llm_calls row for tenant; return its key fields or None."""
    deadline = time.time() + timeout
    cols = "count(), sum(cost_usd), any(source), any(provider), sum(input_tokens+output_tokens)"
    while time.time() < deadline:
        try:
            row = ch_query(
                f"SELECT {cols} FROM agentledger.llm_calls "
                f"WHERE tenant_id='{tenant}' FORMAT TabSeparated")
        except (urllib.error.URLError, OSError) as exc:
            print(f"  query error (retrying): {exc}")
            row = ""
        parts = row.split("\t")
        if len(parts) == 5 and parts[0].isdigit() and int(parts[0]) >= 1:
            return {
                "count": int(parts[0]),
                "cost": float(parts[1]),
                "source": parts[2],
                "provider": parts[3],
                "tokens": int(parts[4]),
            }
        time.sleep(1)
    return None


def check_otel() -> bool:
    tenant = f"e2e_otel_{uuid.uuid4().hex[:10]}"
    print(f"[otel] posting gen_ai span for tenant {tenant} ...")
    span = {
        "spanId": "span-" + uuid.uuid4().hex[:8],
        "traceId": "trace-" + uuid.uuid4().hex[:8],
        "name": "chat gpt-4o",
        "startTimeUnixNano": "1718800000000000000",
        "endTimeUnixNano": "1718800001000000000",
        "attributes": [
            {"key": "gen_ai.system", "value": {"stringValue": "openai"}},
            {"key": "gen_ai.request.model", "value": {"stringValue": "gpt-4o"}},
            {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "100"}},
            {"key": "gen_ai.usage.output_tokens", "value": {"intValue": "40"}},
            {"key": "gen_ai.usage.cost", "value": {"doubleValue": 0.0125}},
        ],
        "status": {"code": 1},
    }
    payload = {"resourceSpans": [{
        "resource": {"attributes": [
            {"key": "agentledger.tenant_id", "value": {"stringValue": tenant}}]},
        "scopeSpans": [{"spans": [span]}],
    }]}
    status, body = post_json(COLLECTOR_URL + "/v1/ingest/otel", payload)
    if status != 200:
        print(f"[otel] FAIL: collector returned {status}: {body}")
        return False

    row = poll_row(tenant)
    if not row:
        print("[otel] FAIL: row never reached ClickHouse within 30s")
        return False
    ok = row["source"] == "otel" and row["provider"] == "openai" \
        and row["tokens"] == 140 and abs(row["cost"] - 0.0125) < 1e-9
    print(f"[otel] {'PASS' if ok else 'FAIL'}: {row}")
    return ok


def check_litellm() -> bool:
    tenant = f"e2e_llm_{uuid.uuid4().hex[:10]}"
    print(f"[litellm] posting spend log for tenant {tenant} ...")
    rec = {
        "id": "req-" + uuid.uuid4().hex[:8],
        "call_type": "acompletion",
        "custom_llm_provider": "anthropic",
        "model": "claude-3-5-sonnet",
        "response_cost": 0.0333,
        "prompt_tokens": 200,
        "completion_tokens": 50,
        "startTime": 1718800000.0,
        "endTime": 1718800002.0,
        "status": "success",
        "metadata": {"agentledger_tenant_id": tenant, "user_api_key_team_id": "team_e2e"},
    }
    status, body = post_json(ADAPTER_URL + "/ingest/litellm", rec)
    if status not in (200, 202):
        print(f"[litellm] FAIL: adapter returned {status}: {body}")
        return False

    row = poll_row(tenant)
    if not row:
        print("[litellm] FAIL: row never reached ClickHouse within 30s")
        return False
    ok = row["source"] == "adapter" and row["provider"] == "anthropic" \
        and row["tokens"] == 250 and abs(row["cost"] - 0.0333) < 1e-9
    print(f"[litellm] {'PASS' if ok else 'FAIL'}: {row}")
    return ok


def main() -> int:
    print(f"waiting for collector at {COLLECTOR_URL} ...")
    if not wait_http(COLLECTOR_URL + "/healthz"):
        print("FAIL: collector not reachable — is the stack up?")
        return 1
    print(f"waiting for litellm-adapter at {ADAPTER_URL} ...")
    if not wait_http(ADAPTER_URL + "/healthz"):
        print("FAIL: litellm-adapter not reachable — is the stack up?")
        return 1
    print(f"waiting for clickhouse at {CLICKHOUSE_URL} ...")
    if not wait_http(CLICKHOUSE_URL + "/ping"):
        print("FAIL: clickhouse not reachable — is the stack up?")
        return 1

    results = [check_otel(), check_litellm()]
    if all(results):
        print("PASS: both third-party sources reached ClickHouse with correct cost + attribution")
        return 0
    print("FAIL: one or more ingestion paths did not materialize correctly")
    return 1


if __name__ == "__main__":
    sys.exit(main())
