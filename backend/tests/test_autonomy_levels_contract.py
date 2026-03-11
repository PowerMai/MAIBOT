from __future__ import annotations

from backend.engine.autonomy import levels


def test_autonomy_level_clamp_by_tier(monkeypatch):
    monkeypatch.setattr(levels, "max_autonomy_level", lambda _profile: "L1")
    assert levels._clamp_level_by_tier("L3", {"tier": "free"}) == "L1"
    assert levels._clamp_level_by_tier("L0", {"tier": "free"}) == "L0"


def test_autonomy_policy_decision_l1_allow_write_and_task():
    """L1 允许 write_file 与 task（与 Agent 模式预期一致）。"""
    decision = levels.explain_tool_policy_by_level("write_file", "L1", {"path": "x"})
    assert decision["allowed"] is True
    assert decision["policy_layer"] == "autonomy"
    assert decision["reason_code"] == "autonomy_default_allow"
    decision_task = levels.explain_tool_policy_by_level("task", "L1", {"description": "test"})
    assert decision_task["allowed"] is True
    assert decision_task["reason_code"] == "autonomy_default_allow"


def test_autonomy_policy_decision_l2_shell_bypass(monkeypatch):
    monkeypatch.setattr(levels, "is_shell_command_blocked", lambda _cmd: (False, ""))
    decision = levels.explain_tool_policy_by_level("shell_run", "L2", {"command": "echo $(uname -a)"})
    assert decision["allowed"] is False
    assert decision["reason_code"] == "autonomy_l2_shell_bypass_risk"


def test_autonomy_policy_decision_l3_allow():
    decision = levels.explain_tool_policy_by_level("write_file", "L3", {"path": "x"})
    assert decision["allowed"] is True
    assert decision["reason_code"] == "autonomy_l3_allow"
