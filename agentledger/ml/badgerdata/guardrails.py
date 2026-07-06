"""Guardrails — the risk-classification analog of the ROI engine's dollar-figure
check (_verify_numbers). The gate: a rationale may only name tools / MCP servers
that actually appear in the behavior it describes. Any in-vocabulary tool/server
token in a rationale that is NOT present in the input is an invented-content
violation. This is asserted on every gold training answer (fail loud) and measured
on model output during eval (the 100% ship gate).
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from .schema import Assessment, is_valid_finding
from .vocab import VOCAB

_TOKEN_RE = re.compile(r"[a-z][a-z0-9_]+")


def rationale_tokens(text: str) -> set[str]:
    """Word-boundary tokens (lowercased identifiers) in a rationale."""
    return set(_TOKEN_RE.findall(text.lower()))


def verify_no_invented_content(
    rationale: str, present_tokens: Iterable[str]
) -> tuple[bool, list[str]]:
    """Return (ok, invented) where invented are in-vocab tool/server names named in
    the rationale but absent from present_tokens."""
    present = set(present_tokens)
    mentioned = rationale_tokens(rationale) & VOCAB
    invented = sorted(mentioned - present)
    return (len(invented) == 0, invented)


def assessment_guardrail_ok(
    assessment: Assessment, present_tokens: Iterable[str]
) -> tuple[bool, list[str]]:
    """Full guardrail for one assessment: every finding must be schema-valid AND its
    rationale must invent no tool/server. Returns (ok, violations)."""
    present = set(present_tokens)
    violations: list[str] = []
    for f in assessment.findings:
        if not is_valid_finding(f):
            violations.append(f"invalid finding: category={f.category!r} confidence={f.confidence}")
            continue
        ok, invented = verify_no_invented_content(f.rationale, present)
        if not ok:
            violations.append(f"invented {invented} in rationale for {f.category}")
    return (len(violations) == 0, violations)
