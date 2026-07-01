"""BadgerIQ Python SDK (MVP).

Stdlib-only tracing for agents and workflows. Emits events aligned with
the OpenTelemetry GenAI semantic conventions (gen_ai.* attribute names)
and BadgerIQ's canonical schema, so the same data lands cleanly in
ClickHouse and any OTel-compatible backend.

Two integration paths:

1. Route LLM traffic through the BadgerIQ gateway and use this SDK
   only for run/step/outcome context (headers propagate run identity):

       import agentledger as al

       al.init(collector_url="http://localhost:8090/v1/events",
               tenant_id="t1", app_id="support-copilot")

       with al.run(agent_id="ticket-triage", objective="triage #4812") as run:
           headers = run.llm_headers()      # pass to your OpenAI client
           ...                              # gateway records cost per call
           run.record_outcome("ticket_resolved", source_system="zendesk",
                              ref="4812", business_value_usd=18.50,
                              attribution_confidence=0.9)

2. No gateway (direct provider calls): also report usage explicitly with
   run.record_llm_call(...) so cost attribution still works.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional

__all__ = ["init", "run", "Run"]

_config: dict[str, Any] = {}
_lock = threading.Lock()


def init(collector_url: str, tenant_id: str, app_id: str,
         user_id: str = "", environment: str = "prod",
         api_key: Optional[str] = None) -> None:
    """Configure the SDK once per process."""
    with _lock:
        _config.update(
            collector_url=collector_url,
            tenant_id=tenant_id,
            app_id=app_id,
            user_id=user_id or os.getenv("USER", ""),
            environment=environment,
            # Prefer LEDGERAI_API_KEY; fall back to the legacy AGENTLEDGER_API_KEY alias.
            api_key=api_key or os.getenv("LEDGERAI_API_KEY") or os.getenv("AGENTLEDGER_API_KEY", ""),
        )


def _post(payload: dict[str, Any]) -> None:
    """Fire-and-forget event post; never raises into the host app."""
    def _send() -> None:
        try:
            data = json.dumps(payload).encode()
            req = urllib.request.Request(
                _config["collector_url"], data=data,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {_config.get('api_key','')}",
                },
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass  # telemetry must never break the workload
    threading.Thread(target=_send, daemon=True).start()


@dataclass
class Run:
    """An agent run: the unit-economics denominator."""
    agent_id: str
    objective: str = ""
    run_id: str = field(default_factory=lambda: f"run_{uuid.uuid4().hex[:16]}")
    started_at: float = field(default_factory=time.time)
    status: str = "completed"
    _llm_calls: int = 0
    _tool_calls: int = 0
    _cost_usd: float = 0.0
    _tokens: int = 0
    _step_seq: int = 0

    # ----- gateway integration -----
    def llm_headers(self, step_id: str = "") -> dict[str, str]:
        """Headers that propagate run identity through the gateway."""
        return {
            "X-AgentLedger-Agent-Id": self.agent_id,
            "X-AgentLedger-Run-Id": self.run_id,
            "X-AgentLedger-Step-Id": step_id or self._next_step(),
        }

    def _next_step(self) -> str:
        self._step_seq += 1
        return f"step_{self._step_seq}"

    # ----- direct-call accounting (no gateway) -----
    def record_llm_call(self, provider: str, model: str,
                        input_tokens: int, output_tokens: int,
                        cost_usd: float = 0.0, latency_ms: int = 0,
                        cache_read_tokens: int = 0) -> None:
        self._llm_calls += 1
        self._cost_usd += cost_usd
        self._tokens += input_tokens + output_tokens
        _post({
            "kind": "llm_call",
            "call_id": f"call_{uuid.uuid4().hex[:16]}",
            "ts": _iso_now(),
            "tenant_id": _config["tenant_id"],
            "app_id": _config["app_id"],
            "user_id": _config["user_id"],
            "environment": _config["environment"],
            "agent_id": self.agent_id,
            "run_id": self.run_id,
            "step_id": self._next_step(),
            # gen_ai.* aligned
            "provider": provider,                 # gen_ai.provider.name
            "request_model": model,               # gen_ai.request.model
            "operation_name": "chat",             # gen_ai.operation.name
            "input_tokens": input_tokens,         # gen_ai.usage.input_tokens
            "output_tokens": output_tokens,       # gen_ai.usage.output_tokens
            "cache_read_tokens": cache_read_tokens,
            "cost_usd": cost_usd,
            "latency_ms": latency_ms,
            "status": "ok",
            "source": "sdk",
        })

    def record_tool_call(self, tool_name: str, status: str = "ok",
                         latency_ms: int = 0, mcp_server: str = "") -> None:
        self._tool_calls += 1
        _post({
            "kind": "tool_call",
            # Stable, unique id — the agent_tool_calls dedup key (without it,
            # ClickHouse's ReplacingMergeTree collapses an agent's tool calls).
            "tool_call_id": f"tool_{uuid.uuid4().hex[:16]}",
            "ts": _iso_now(),
            "tenant_id": _config["tenant_id"], "run_id": self.run_id,
            "agent_id": self.agent_id, "step_id": self._next_step(),
            "operation_name": "execute_tool",     # gen_ai agent-span convention
            "tool_name": tool_name,               # gen_ai.tool.name
            "mcp_server": mcp_server,             # MCP server id, if any
            "status": status, "latency_ms": latency_ms,
            "source": "sdk",
        })

    # ----- the differentiator: business outcomes -----
    def record_outcome(self, outcome_type: str, source_system: str,
                       ref: str = "", business_value_usd: float = 0.0,
                       quality_score: float = 0.0,
                       attribution_confidence: float = 1.0) -> str:
        outcome_id = f"out_{uuid.uuid4().hex[:16]}"
        _post({
            "kind": "outcome", "outcome_id": outcome_id, "ts": _iso_now(),
            "tenant_id": _config["tenant_id"],
            "user_id": _config["user_id"],
            "run_id": self.run_id,
            "source_system": source_system,
            "outcome_type": outcome_type,
            "ref": ref,
            "business_value_usd": business_value_usd,
            "quality_score": quality_score,
            "attribution_confidence": attribution_confidence,
            "completion_status": "completed",
        })
        return outcome_id

    def fail(self, reason: str = "") -> None:
        self.status = "failed"
        if reason:
            self.objective = f"{self.objective} [failed: {reason}]"

    def _close(self) -> None:
        _post({
            "kind": "agent_run", "run_id": self.run_id, "ts": _iso_now(),
            "tenant_id": _config["tenant_id"],
            "app_id": _config["app_id"],
            "user_id": _config["user_id"],
            "agent_id": self.agent_id,
            "objective": self.objective,
            "started_at": _iso(self.started_at),
            "ended_at": _iso_now(),
            "status": self.status,
            "llm_calls": self._llm_calls,
            "tool_calls": self._tool_calls,
            "total_cost_usd": round(self._cost_usd, 6),
            "total_tokens": self._tokens,
        })


@contextmanager
def run(agent_id: str, objective: str = "") -> Iterator[Run]:
    """Context manager for an agent run; always emits a closing record."""
    if not _config:
        raise RuntimeError("call agentledger.init(...) before agentledger.run(...)")
    r = Run(agent_id=agent_id, objective=objective)
    try:
        yield r
    except Exception as exc:
        r.fail(type(exc).__name__)
        r._close()
        raise
    else:
        r._close()


def _iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + "Z"


def _iso_now() -> str:
    return _iso(time.time())
