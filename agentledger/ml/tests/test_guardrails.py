from badgerdata import (
    Assessment,
    Finding,
    assessment_guardrail_ok,
    verify_no_invented_content,
)


def test_verify_no_invented_content_clean():
    ok, invented = verify_no_invented_content(
        "read_file then http_post looks like data egress", {"read_file", "http_post"}
    )
    assert ok and invented == []


def test_verify_no_invented_content_flags_invented_tool():
    # upload_s3 is a real vocab tool but is NOT present in this behavior → invented.
    ok, invented = verify_no_invented_content(
        "read_file then upload_s3 exfiltrates data", {"read_file", "http_post"}
    )
    assert not ok and invented == ["upload_s3"]


def test_verify_ignores_non_vocab_words():
    ok, invented = verify_no_invented_content(
        "researching the sensitive external channel", {"read_file"}
    )
    # 'search' is a vocab tool but must not match inside 'researching' (word boundary).
    assert ok and invented == []


def test_assessment_guardrail_ok_present_tokens():
    a = Assessment(findings=[Finding(
        category="data_egress", severity="high", confidence=0.9,
        rationale="read_file then http_post",
    )])
    ok, violations = assessment_guardrail_ok(a, {"read_file", "http_post"})
    assert ok and violations == []


def test_assessment_guardrail_flags_invented():
    a = Assessment(findings=[Finding(
        category="data_egress", severity="high", confidence=0.9,
        rationale="db_query then send_email",
    )])
    ok, violations = assessment_guardrail_ok(a, {"read_file", "http_post"})
    assert not ok and violations


def test_assessment_guardrail_flags_invalid_finding():
    a = Assessment(findings=[Finding(
        category="not_a_category", severity="high", confidence=0.9, rationale="x",
    )])
    ok, violations = assessment_guardrail_ok(a, set())
    assert not ok and violations
