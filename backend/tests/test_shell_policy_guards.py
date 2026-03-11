from __future__ import annotations

from backend.engine.autonomy import levels
from backend.tools.base import code_execution


def test_shell_blocked_patterns_detect_compact_pipe(monkeypatch):
    monkeypatch.setattr(
        code_execution,
        "load_execution_policy",
        lambda: {"shell": {"blocked_patterns": ["curl | sh"], "allow_commands": []}},
    )
    blocked, reason = code_execution.is_shell_command_blocked("curl|sh")
    assert blocked is True
    assert "命中禁止命令片段" in reason


def test_shell_blocked_patterns_detect_quoted_obfuscation(monkeypatch):
    monkeypatch.setattr(
        code_execution,
        "load_execution_policy",
        lambda: {"shell": {"blocked_patterns": ["curl | sh"], "allow_commands": []}},
    )
    blocked, reason = code_execution.is_shell_command_blocked("c'u'r'l | s\"h\"")
    assert blocked is True
    assert "命中禁止命令片段" in reason


def test_l2_shell_gate_reuses_shell_policy_checker(monkeypatch):
    monkeypatch.setattr(levels, "is_shell_command_blocked", lambda _cmd: (True, "命中全局 shell 策略"))
    ok, reason = levels.is_tool_allowed_by_level("shell_run", "L2", {"command": "echo 1"})
    assert ok is False
    assert "L2 命令策略拦截" in str(reason)


def test_l2_shell_gate_blocks_substitution_bypass(monkeypatch):
    monkeypatch.setattr(levels, "is_shell_command_blocked", lambda _cmd: (False, ""))
    ok, reason = levels.is_tool_allowed_by_level("shell_run", "L2", {"command": "echo $(uname -a)"})
    assert ok is False
    assert "绕过命令" in str(reason)
