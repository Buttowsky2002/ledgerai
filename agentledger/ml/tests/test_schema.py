from badgerdata import (
    assessment_json_schema,
    extract_json_object,
    parse_and_validate,
)


def test_extract_json_object_balances():
    assert extract_json_object('prefix {"a":{"b":"}"},"c":1} tail') == '{"a":{"b":"}"},"c":1}'
    assert extract_json_object("no object here") is None
    assert extract_json_object('```json\n{"findings":[]}\n```') == '{"findings":[]}'


def test_parse_and_validate_valid():
    raw = '{"findings":[{"category":"data_egress","severity":"high","confidence":0.9,"rationale":"x"}]}'
    a = parse_and_validate(raw)
    assert a is not None and len(a.findings) == 1
    assert a.findings[0].category == "data_egress"


def test_parse_and_validate_drops_invalid_category():
    raw = (
        '{"findings":['
        '{"category":"mind_control","severity":"high","confidence":0.9,"rationale":"x"},'
        '{"category":"data_egress","severity":"low","confidence":0.5,"rationale":"y"}]}'
    )
    a = parse_and_validate(raw)
    assert a is not None and [f.category for f in a.findings] == ["data_egress"]


def test_parse_and_validate_drops_out_of_range_confidence():
    raw = '{"findings":[{"category":"data_egress","severity":"high","confidence":1.5,"rationale":"x"}]}'
    a = parse_and_validate(raw)
    assert a is not None and a.findings == []


def test_parse_and_validate_normalizes_bad_severity():
    raw = '{"findings":[{"category":"data_egress","severity":"nuclear","confidence":0.6,"rationale":"x"}]}'
    a = parse_and_validate(raw)
    assert a is not None and a.findings[0].severity == "low"


def test_parse_and_validate_non_json():
    assert parse_and_validate("I refuse") is None
    assert parse_and_validate('{"findings": "not a list"}') is None


def test_parse_and_validate_null_or_missing_findings_is_empty():
    # Mirrors Go parseAssessment: nil/absent findings → valid empty assessment.
    for raw in ('{"findings":null}', "{}"):
        a = parse_and_validate(raw)
        assert a is not None and a.findings == []


def test_parse_and_validate_defaults_missing_fields():
    # A finding missing rationale is kept with an empty rationale (Go zero-values it),
    # not treated as unparseable — as long as category/confidence are valid.
    raw = '{"findings":[{"category":"data_egress","severity":"high","confidence":0.7}]}'
    a = parse_and_validate(raw)
    assert a is not None and len(a.findings) == 1 and a.findings[0].rationale == ""


def test_parse_and_validate_type_mismatch_is_unparseable():
    # A wrong-typed confidence that cannot coerce → whole payload unparseable (like Go).
    assert parse_and_validate('{"findings":[{"category":"data_egress","confidence":{}}]}') is None


def test_assessment_json_schema_shape():
    s = assessment_json_schema()
    assert s["additionalProperties"] is False
    assert s["required"] == ["findings"]
    item = s["properties"]["findings"]["items"]
    assert item["additionalProperties"] is False
    assert set(item["required"]) == {"category", "severity", "confidence", "rationale"}
