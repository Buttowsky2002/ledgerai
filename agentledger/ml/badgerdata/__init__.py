"""badgerdata — the shared BadgerAI contract (prompt, schema, guardrails, vocab).

Kept in lockstep with the Go worker (services/workers/internal/riskenrich) so the
fine-tune trains on exactly what the classifier sees at inference. 100% synthetic:
nothing here reads real tenant data.
"""

from __future__ import annotations

from .guardrails import (
    assessment_guardrail_ok,
    rationale_tokens,
    verify_no_invented_content,
)
from .prompt import SYSTEM_PROMPT, render_behavior
from .schema import (
    CATEGORIES,
    SEVERITIES,
    Assessment,
    Finding,
    assessment_json_schema,
    extract_json_object,
    filter_valid_findings,
    is_valid_finding,
    parse_and_validate,
)
from .vocab import VOCAB, is_untrusted_mcp, tool_kind

__all__ = [
    "CATEGORIES",
    "SEVERITIES",
    "SYSTEM_PROMPT",
    "VOCAB",
    "Assessment",
    "Finding",
    "assessment_guardrail_ok",
    "assessment_json_schema",
    "extract_json_object",
    "filter_valid_findings",
    "is_untrusted_mcp",
    "is_valid_finding",
    "parse_and_validate",
    "rationale_tokens",
    "render_behavior",
    "tool_kind",
    "verify_no_invented_content",
]
