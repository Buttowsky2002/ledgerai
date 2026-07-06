from badgerdata import assessment_guardrail_ok, parse_and_validate
from datagen.generate import Behavior, generate_dataset, label_behavior
from eval.run_eval import behavior_tokens_from_user

RISKY = ("injection_suspected", "data_egress", "privilege_escalation", "anomalous_sequence")


def _present(example: dict) -> set[str]:
    user = next(m["content"] for m in example["messages"] if m["role"] == "user")
    return behavior_tokens_from_user(user)


def _risky_findings(example: dict) -> list:
    a = parse_and_validate(example["messages"][2]["content"])
    assert a is not None
    return [f for f in a.findings if f.category != "none"]


def test_generate_dataset_counts_and_guardrails():
    splits = generate_dataset(n=200, seed=1)
    assert sum(len(v) for v in splits.values()) == 200
    assert len(splits["train"]) > len(splits["val"]) >= 1
    assert len(splits["test"]) >= 1

    seen = set()
    for rows in splits.values():
        for ex in rows:
            assert [m["role"] for m in ex["messages"]] == ["system", "user", "assistant"]
            a = parse_and_validate(ex["messages"][2]["content"])
            assert a is not None, "gold must be parseable"
            ok, violations = assessment_guardrail_ok(a, _present(ex))
            assert ok, violations
            for f in a.findings:
                seen.add(f.category)
    for cat in RISKY:
        assert cat in seen, f"missing category {cat} in {seen}"


def test_hard_negatives_present_in_val_and_test():
    splits = generate_dataset(n=200, seed=1)
    for name in ("val", "test"):
        benign = [ex for ex in splits[name] if not _risky_findings(ex)]
        assert benign, f"expected benign hard negatives in {name}"


def test_label_behavior_is_deterministic():
    b = Behavior("a", "r", ["read_file", "http_post"], [])
    assert label_behavior(b).model_dump() == label_behavior(b).model_dump()
    assert label_behavior(b).findings[0].category == "data_egress"


def test_label_rules():
    inj = Behavior("a", "r", ["mcp_fetch", "http_post"], ["untrusted_web"])
    assert label_behavior(inj).findings[0].category == "injection_suspected"

    priv = Behavior("a", "r", ["search", "sudo_exec"], [])
    assert label_behavior(priv).findings[0].category == "privilege_escalation"

    anomalous = Behavior("a", "r", ["http_post", "search", "send_email"], [])
    assert label_behavior(anomalous).findings[0].category == "anomalous_sequence"

    # Trusted MCP source + single send → benign (restraint).
    trusted = Behavior("a", "r", ["mcp_fetch", "http_post"], ["internal_docs"])
    assert label_behavior(trusted).findings == []

    # Sensitive read with no external send → benign.
    read_only = Behavior("a", "r", ["read_file", "summarize"], [])
    assert label_behavior(read_only).findings == []
