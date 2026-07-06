"""The AgentSynthesis-equivalent output contract: Finding / Assessment plus the
tolerant parse+validate path that mirrors the Go classifier (extractJSONObject +
validateAssessment). Kept in sync with classifier.go.
"""

from __future__ import annotations

import json

from pydantic import BaseModel, Field

CATEGORIES: tuple[str, ...] = (
    "injection_suspected",
    "data_egress",
    "privilege_escalation",
    "anomalous_sequence",
    "none",
)
SEVERITIES: tuple[str, ...] = ("low", "medium", "high")


class Finding(BaseModel):
    """One semantic risk finding. Fields are permissive on purpose; validity is
    enforced by filter_valid_findings so we can tolerantly parse model output."""

    category: str
    severity: str
    confidence: float
    rationale: str


class Assessment(BaseModel):
    findings: list[Finding] = Field(default_factory=list)


def assessment_json_schema() -> dict:
    """The JSON Schema output is constrained to — mirrors the Go assessmentSchema()
    (additionalProperties:false, explicit required) so the served model's
    guided_json / response_format matches what we trained on."""
    return {
        "type": "object",
        "properties": {
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "category": {"type": "string", "enum": list(CATEGORIES)},
                        "severity": {"type": "string", "enum": list(SEVERITIES)},
                        "confidence": {"type": "number"},
                        "rationale": {"type": "string"},
                    },
                    "required": ["category", "severity", "confidence", "rationale"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["findings"],
        "additionalProperties": False,
    }


def extract_json_object(text: str) -> str | None:
    """Return the first balanced top-level JSON object in text, tolerating code
    fences or prose around it. Mirrors the Go extractJSONObject balanced-brace scan.
    """
    s = text.strip()
    start = s.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return s[start : i + 1]
    return None


def is_valid_finding(f: Finding) -> bool:
    """A finding is trustworthy only if its category is in the enum and its
    confidence is in [0, 1]. Mirrors the Go validateAssessment drop rules."""
    return f.category in CATEGORIES and 0.0 <= f.confidence <= 1.0


def filter_valid_findings(findings: list[Finding]) -> list[Finding]:
    """Drop findings with an out-of-enum category or out-of-range confidence;
    normalize an unknown severity to 'low'. Never invents or clamps values."""
    kept: list[Finding] = []
    for f in findings:
        if not is_valid_finding(f):
            continue
        severity = f.severity if f.severity in SEVERITIES else "low"
        kept.append(Finding(category=f.category, severity=severity, confidence=f.confidence, rationale=f.rationale))
    return kept


def parse_and_validate(text: str) -> Assessment | None:
    """Tolerantly extract, parse, and validate an assessment from model output.
    Returns None if nothing parseable is found (the caller then retries / falls
    back), never an assessment built from invalid findings."""
    raw = extract_json_object(text)
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    findings_raw = data.get("findings")
    if findings_raw is None:  # missing or null → empty (mirrors Go's nil slice)
        return Assessment(findings=[])
    if not isinstance(findings_raw, list):
        return None
    findings: list[Finding] = []
    for item in findings_raw:
        if not isinstance(item, dict):
            return None
        try:
            # Default missing fields (Go zero-values them on unmarshal); a genuine
            # type mismatch still raises → whole payload unparseable, matching Go.
            findings.append(Finding(
                category=item.get("category", ""),
                severity=item.get("severity", ""),
                confidence=item.get("confidence", 0.0),
                rationale=item.get("rationale", ""),
            ))
        except (TypeError, ValueError):
            return None
    return Assessment(findings=filter_valid_findings(findings))
