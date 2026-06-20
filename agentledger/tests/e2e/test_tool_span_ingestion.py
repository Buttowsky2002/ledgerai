#!/usr/bin/env python3
"""End-to-end acceptance for OTel tool-span ingestion (Pivot Phase 6, C1).

Proves the producer path that makes the agent-native risk engine consume real
data — an OTel execute_tool / gen_ai.tool.* span flows through the full pipeline
into the observed-tool-call table the risk engine reads:

    OTel tool span ─▶ collector /v1/ingest/otel ─▶ Redpanda ─▶ ch-insert ─▶ ClickHouse.agent_tool_calls

A unique tenant id per run isolates the assertions; we check the row
materializes with the right tool_name / mcp_server / agent_id and source='otel'.

Prerequisites — bring the stack up first (from agentledger/):

    docker compose up -d clickhouse redpanda collector ch-insert

Run:

    python3 tests/e2e/test_tool_span_ingestion.py

Environment overrides: COLLECTOR_URL (http://localhost:8090),
CLICKHOUSE_URL (http://localhost:8123).
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
CLICKHOUSE_URL = os.getenv("CLICKHOUSE_URL", "http://localhost:8123")


def ch_query(sql: str) -> str:
    url = CLICKHOUSE_URL + "/?query=" + urllib.parse.quote(sql)
    with urllib.request.urlopen(url, timeout=5) as r:  # noqa: S310 (local dev URL)
        return r.read().decode().strip()


def post_json(url: str, payload) -> tuple[int, str]:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
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


def poll_tool_call(tenant: str, timeout: float = 30.0) -> dict | None:
    """Wait for the agent_tool_calls row for tenant; return its key fields."""
    deadline = time.time() + timeout
    cols = "count(), any(tool_name), any(mcp_server), any(agent_id)"
    while time.time() < deadline:
        try:
            row = ch_query(
                f"SELECT {cols} FROM agentledger.agent_tool_calls FINAL "
                f"WHERE tenant_id='{tenant}' FORMAT TabSeparated")
        except (urllib.error.URLError, OSError) as exc:
            print(f"  query error (retrying): {exc}")
            row = ""
        parts = row.split("\t")
        if len(parts) == 4 and parts[0].isdigit() and int(parts[0]) >= 1:
            return {
                "count": int(parts[0]),
                "tool_name": parts[1],
                "mcp_server": parts[2],
                "agent_id": parts[3],
            }
        time.sleep(1)
    return None


def check_tool_span() -> bool:
    tenant = f"e2e_tool_{uuid.uuid4().hex[:10]}"
    print(f"[tool] posting execute_tool span for tenant {tenant} ...")
    span = {
        "spanId": "span-" + uuid.uuid4().hex[:8],
        "traceId": "trace-" + uuid.uuid4().hex[:8],
        "name": "execute_tool shell.exec",
        "startTimeUnixNano": "1718800000000000000",
        "endTimeUnixNano": "1718800000500000000",
        "attributes": [
            {"key": "gen_ai.operation.name", "value": {"stringValue": "execute_tool"}},
            {"key": "gen_ai.tool.name", "value": {"stringValue": "shell.exec"}},
            {"key": "gen_ai.tool.call.id", "value": {"stringValue": "tc-" + uuid.uuid4().hex[:8]}},
            {"key": "agentledger.agent_id", "value": {"stringValue": "triage"}},
            {"key": "agentledger.mcp_server", "value": {"stringValue": "filesystem"}},
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
        print(f"[tool] FAIL: collector returned {status}: {body}")
        return False

    row = poll_tool_call(tenant)
    if not row:
        print("[tool] FAIL: tool call never reached ClickHouse within 30s")
        return False
    ok = (row["count"] == 1 and row["tool_name"] == "shell.exec"
          and row["mcp_server"] == "filesystem" and row["agent_id"] == "triage")
    print(f"[tool] {'PASS' if ok else 'FAIL'}: {row}")
    return ok


def main() -> int:
    print(f"waiting for collector at {COLLECTOR_URL} ...")
    if not wait_http(COLLECTOR_URL + "/healthz"):
        print("FAIL: collector not reachable — is the stack up?")
        return 1
    print(f"waiting for clickhouse at {CLICKHOUSE_URL} ...")
    if not wait_http(CLICKHOUSE_URL + "/ping"):
        print("FAIL: clickhouse not reachable — is the stack up?")
        return 1

    if check_tool_span():
        print("PASS: OTel tool span reached agent_tool_calls with correct attribution")
        return 0
    print("FAIL: tool-span ingestion did not materialize correctly")
    return 1


if __name__ == "__main__":
    sys.exit(main())
