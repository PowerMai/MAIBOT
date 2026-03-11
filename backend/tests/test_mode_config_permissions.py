from backend.engine.modes.mode_config import is_tool_allowed, explain_tool_policy_decision


def test_ask_mode_is_readonly_for_write_tools():
    assert is_tool_allowed("ask", "read_file") is True
    assert is_tool_allowed("ask", "write_file") is False
    assert is_tool_allowed("ask", "edit_file") is False
    assert is_tool_allowed("ask", "python_run") is False


def test_mode_policy_decision_returns_reason_code():
    denied = explain_tool_policy_decision("ask", "write_file")
    assert denied["allowed"] is False
    assert denied["policy_layer"] == "mode"
    assert denied["reason_code"] == "mode_allowlist_miss"
    assert "allowlist" in denied["reason_text"]

    allowed = explain_tool_policy_decision("agent", "write_file")
    assert allowed["allowed"] is True
    assert allowed["reason_code"] == "mode_allow_all"
