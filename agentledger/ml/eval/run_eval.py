"""Eval harness — the BadgerAI regression gate (run in CI on any adapter change).

Scores model output on the held-out test set and enforces SHIP GATES:
  - JSON-valid          >= 0.98
  - guardrail pass      >= 0.95   (schema-valid AND no invented tool/server)
  - no-invented-content == 1.00   (the hedging-equivalent hard gate)
Also reports (non-gating) coverage (top gold category surfaced) and hard-negative
restraint (benign gold → benign prediction). Below any gate → exits non-zero with a
diff report of the offending examples.

Two prediction sources:
  --endpoint http://localhost:8000  (OpenAI-compatible: vLLM/Ollama/…), or
  --predictions preds.jsonl         (offline/CI replay; one raw string per line as
                                      {"content": "..."} aligned to the test set).

    python -m eval.run_eval --test data/test.jsonl --predictions preds.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from badgerdata import (
    CATEGORIES,
    SEVERITIES,
    Assessment,
    assessment_guardrail_ok,
    extract_json_object,
    parse_and_validate,
    verify_no_invented_content,
)

_RISKY = tuple(c for c in CATEGORIES if c != "none")

GATES = {"json_valid": 0.98, "guardrail_pass": 0.95, "no_invented": 1.0}


@dataclass
class Metrics:
    n: int = 0
    json_valid: float = 0.0
    schema_valid: float = 0.0
    guardrail_pass: float = 0.0
    no_invented: float = 0.0
    coverage: float = 0.0
    hard_negative_restraint: float = 0.0
    failures: list[dict] = field(default_factory=list)


def behavior_tokens_from_user(user_text: str) -> set[str]:
    """Recover the tool / MCP-server tokens from a rendered user message so the
    guardrail can be checked at eval time."""
    tokens: set[str] = set()
    for line in user_text.splitlines():
        if line.startswith("tool_call_sequence:"):
            seq = line.split(":", 1)[1].strip()
            tokens.update(t.strip() for t in seq.split("->") if t.strip())
        elif line.startswith("mcp_servers:"):
            servers = line.split(":", 1)[1].strip()
            tokens.update(s.strip() for s in servers.split(",") if s.strip())
    return tokens


def _strict_schema_ok(raw: str) -> bool:
    obj = extract_json_object(raw)
    if obj is None:
        return False
    try:
        data = json.loads(obj)
    except (ValueError, TypeError):
        return False
    if not isinstance(data, dict) or not isinstance(data.get("findings"), list):
        return False
    required = {"category", "severity", "confidence", "rationale"}
    for f in data["findings"]:
        if not isinstance(f, dict) or required - set(f):
            return False
        if f["category"] not in CATEGORIES or f["severity"] not in SEVERITIES:
            return False
        if not isinstance(f["confidence"], (int, float)) or isinstance(f["confidence"], bool):
            return False
        if not (0.0 <= f["confidence"] <= 1.0) or not isinstance(f["rationale"], str):
            return False
    return True


def _json_object_ok(raw: str) -> bool:
    obj = extract_json_object(raw)
    if obj is None:
        return False
    try:
        return isinstance(json.loads(obj), dict)
    except (ValueError, TypeError):
        return False


def _gold_categories(gold: Assessment) -> set[str]:
    return {f.category for f in gold.findings if f.category in _RISKY}


def compute_metrics(examples: list[dict], predictions: list[str]) -> Metrics:
    if len(examples) != len(predictions):
        raise ValueError(f"examples ({len(examples)}) and predictions ({len(predictions)}) misaligned")

    m = Metrics(n=len(examples))
    json_ok = schema_ok = guard_ok = noinv_ok = 0
    cov_total = cov_hit = 0
    hn_total = hn_hit = 0

    for i, (ex, raw) in enumerate(zip(examples, predictions, strict=True)):
        msgs = {msg["role"]: msg["content"] for msg in ex["messages"]}
        present = behavior_tokens_from_user(msgs.get("user", ""))
        gold = Assessment.model_validate_json(msgs["assistant"])
        gold_cats = _gold_categories(gold)

        this_json = _json_object_ok(raw)
        this_schema = _strict_schema_ok(raw)
        parsed = parse_and_validate(raw)
        this_guard = False
        this_noinv = True
        if parsed is not None:
            g_ok, _ = assessment_guardrail_ok(parsed, present)
            this_guard = g_ok
            for f in parsed.findings:
                ok, _inv = verify_no_invented_content(f.rationale, present)
                if not ok:
                    this_noinv = False
        else:
            this_noinv = True  # nothing parsed → nothing invented (json_valid gate catches malformed)

        json_ok += this_json
        schema_ok += this_schema
        guard_ok += this_guard
        noinv_ok += this_noinv

        # Coverage: for gold risky examples, did the prediction surface that category?
        if gold_cats:
            cov_total += 1
            pred_cats = {f.category for f in parsed.findings} if parsed else set()
            if gold_cats & pred_cats:
                cov_hit += 1
        else:
            # Hard-negative restraint: benign gold → prediction must be benign too.
            hn_total += 1
            pred_risky = {f.category for f in parsed.findings if f.category in _RISKY} if parsed else set()
            if not pred_risky:
                hn_hit += 1

        if not (this_json and this_guard and this_noinv):
            m.failures.append({
                "index": i,
                "json": this_json,
                "schema": this_schema,
                "guardrail": this_guard,
                "no_invented": this_noinv,
                "gold": sorted(gold_cats) or ["benign"],
                "raw": raw[:200],
            })

    n = max(m.n, 1)
    m.json_valid = json_ok / n
    m.schema_valid = schema_ok / n
    m.guardrail_pass = guard_ok / n
    m.no_invented = noinv_ok / n
    m.coverage = cov_hit / cov_total if cov_total else 1.0
    m.hard_negative_restraint = hn_hit / hn_total if hn_total else 1.0
    return m


def check_gates(m: Metrics) -> tuple[bool, list[str]]:
    msgs: list[str] = []
    passed = True
    for key, floor in GATES.items():
        val = getattr(m, key)
        ok = val >= floor
        passed = passed and ok
        msgs.append(f"  [{'PASS' if ok else 'FAIL'}] {key}: {val:.3f} (gate {floor:.2f})")
    return passed, msgs


def _load_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def _predict_via_endpoint(examples: list[dict], base_url: str, model: str, api_key: str) -> list[str]:
    import httpx  # local import: only needed in endpoint mode

    from badgerdata import assessment_json_schema

    schema = assessment_json_schema()
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    out: list[str] = []
    with httpx.Client(timeout=60.0) as client:
        for ex in examples:
            msgs = [m for m in ex["messages"] if m["role"] in ("system", "user")]
            body = {
                "model": model,
                "messages": msgs,
                "temperature": 0.2,
                "max_tokens": 2000,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {"name": "risk_assessment", "schema": schema, "strict": True},
                },
                "guided_json": schema,
            }
            resp = client.post(f"{base_url.rstrip('/')}/v1/chat/completions", json=body, headers=headers)
            resp.raise_for_status()
            out.append(resp.json()["choices"][0]["message"]["content"])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Evaluate BadgerAI against ship gates.")
    ap.add_argument("--test", type=Path, required=True, help="held-out test JSONL (chat examples)")
    ap.add_argument("--predictions", type=Path, help="offline predictions JSONL ({'content': ...} per line)")
    ap.add_argument("--endpoint", help="OpenAI-compatible base URL to generate predictions live")
    ap.add_argument("--model", default="badger-ai-8b")
    ap.add_argument("--api-key", default="")
    args = ap.parse_args()

    examples = _load_jsonl(args.test)
    if args.predictions:
        preds = [row["content"] for row in _load_jsonl(args.predictions)]
    elif args.endpoint:
        preds = _predict_via_endpoint(examples, args.endpoint, args.model, args.api_key)
    else:
        ap.error("provide --predictions (offline) or --endpoint (live)")

    m = compute_metrics(examples, preds)
    passed, gate_msgs = check_gates(m)

    print(f"BadgerAI eval — n={m.n}")
    print(f"  json_valid={m.json_valid:.3f} schema_valid={m.schema_valid:.3f} "
          f"guardrail_pass={m.guardrail_pass:.3f} no_invented={m.no_invented:.3f}")
    print(f"  coverage={m.coverage:.3f} hard_negative_restraint={m.hard_negative_restraint:.3f}")
    print("Ship gates:")
    print("\n".join(gate_msgs))

    if not passed:
        print(f"\nGATES FAILED — {len(m.failures)} offending example(s):")
        for fail in m.failures[:20]:
            print(f"  #{fail['index']} gold={fail['gold']} json={fail['json']} "
                  f"guard={fail['guardrail']} no_invented={fail['no_invented']} raw={fail['raw']!r}")
        return 1
    print("\nAll ship gates passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
