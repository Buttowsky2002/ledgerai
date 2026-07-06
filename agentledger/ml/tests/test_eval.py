from datagen.generate import Behavior, label_behavior, to_chat_example
from eval.run_eval import behavior_tokens_from_user, check_gates, compute_metrics


def _egress_example() -> dict:
    b = Behavior("a", "r", ["read_file", "http_post"], [])
    return to_chat_example(b, label_behavior(b))


def _benign_example() -> dict:
    b = Behavior("a", "r", ["search"], [])
    return to_chat_example(b, label_behavior(b))


def test_behavior_tokens_from_user():
    ex = _egress_example()
    user = next(m["content"] for m in ex["messages"] if m["role"] == "user")
    assert behavior_tokens_from_user(user) == {"read_file", "http_post"}


def test_perfect_predictions_pass_gates():
    ex = _egress_example()
    gold = ex["messages"][2]["content"]
    m = compute_metrics([ex], [gold])
    assert m.json_valid == 1.0
    assert m.guardrail_pass == 1.0
    assert m.no_invented == 1.0
    passed, _ = check_gates(m)
    assert passed


def test_invented_content_fails_gates():
    ex = _egress_example()
    invented = (
        '{"findings":[{"category":"data_egress","severity":"high","confidence":0.9,'
        '"rationale":"read_file then upload_s3 exfiltrates"}]}'  # upload_s3 not present
    )
    m = compute_metrics([ex], [invented])
    assert m.no_invented == 0.0
    assert m.guardrail_pass == 0.0
    assert not check_gates(m)[0]
    assert m.failures and m.failures[0]["no_invented"] is False


def test_malformed_prediction_fails_json_gate():
    ex = _egress_example()
    m = compute_metrics([ex], ["I cannot help with that request"])
    assert m.json_valid == 0.0
    assert not check_gates(m)[0]


def test_coverage_and_hard_negative_restraint():
    egress, benign = _egress_example(), _benign_example()
    preds = [egress["messages"][2]["content"], '{"findings":[]}']
    m = compute_metrics([egress, benign], preds)
    assert m.coverage == 1.0
    assert m.hard_negative_restraint == 1.0


def test_over_flagging_lowers_restraint():
    benign = _benign_example()
    over = '{"findings":[{"category":"data_egress","severity":"high","confidence":0.9,"rationale":"search"}]}'
    m = compute_metrics([benign], [over])
    assert m.hard_negative_restraint == 0.0
