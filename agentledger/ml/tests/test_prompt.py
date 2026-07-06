from badgerdata import SYSTEM_PROMPT, render_behavior


def test_render_behavior_with_mcp():
    out = render_behavior("a1", "r1", ["read_file", "http_post"], ["untrusted_web"], 2)
    assert out == (
        "agent_id: a1\n"
        "run_id: r1\n"
        "total_tool_calls: 2\n"
        "mcp_servers: untrusted_web\n"
        "tool_call_sequence: read_file -> http_post\n"
    )


def test_render_behavior_without_mcp_omits_line():
    out = render_behavior("a1", "r1", ["search"], [], 1)
    assert "mcp_servers:" not in out
    assert out.endswith("tool_call_sequence: search\n")


def test_system_prompt_lists_categories():
    for cat in ("injection_suspected", "data_egress", "privilege_escalation", "anomalous_sequence"):
        assert cat in SYSTEM_PROMPT
    assert "never see prompt" in SYSTEM_PROMPT
