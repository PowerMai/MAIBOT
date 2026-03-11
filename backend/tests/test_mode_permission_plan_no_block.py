from __future__ import annotations

import json
from types import SimpleNamespace

from langchain_core.messages import ToolMessage

import backend.engine.middleware.mode_permission_middleware as mode_permission_module
from backend.engine.middleware.mode_permission_middleware import ModePermissionMiddleware


def test_plan_mode_allows_write_before_confirm(monkeypatch):
    monkeypatch.setattr(
        mode_permission_module,
        "explain_tool_policy_by_level",
        lambda **kwargs: {
            "allowed": True,
            "policy_layer": "autonomy",
            "reason_code": "autonomy_default_allow",
            "reason_text": "autonomy allow",
        },
    )

    middleware = ModePermissionMiddleware()
    request = SimpleNamespace(
        tool_call={
            "id": "call-1",
            "name": "write_file",
            "args": {"path": "outputs/plan/demo.md", "content": "demo"},
        },
        state={"mode": "plan", "plan_phase": "planning", "plan_confirmed": False},
        runtime=SimpleNamespace(context={"configurable": {}}),
    )

    def _handler(_request):
        return ToolMessage(content="ok", tool_call_id="call-1", name="write_file")

    result = middleware.wrap_tool_call(request, _handler)
    assert isinstance(result, ToolMessage)
    assert result.content == "ok"


def test_ask_mode_blocks_task_when_not_readonly(monkeypatch):
    monkeypatch.setattr(
        mode_permission_module,
        "explain_tool_policy_by_level",
        lambda **kwargs: {
            "allowed": True,
            "policy_layer": "autonomy",
            "reason_code": "autonomy_default_allow",
            "reason_text": "autonomy allow",
        },
    )
    middleware = ModePermissionMiddleware()
    request = SimpleNamespace(
        tool_call={
            "id": "call-2",
            "name": "task",
            "args": {"subagent_type": "explore", "readonly": False},
        },
        state={"mode": "ask"},
        runtime=SimpleNamespace(context={"configurable": {}}),
    )
    result = middleware.wrap_tool_call(request, lambda _request: ToolMessage(content="ok", tool_call_id="call-2", name="task"))
    assert isinstance(result, ToolMessage)
    assert result.status == "error"
    payload = json.loads(str(result.content))
    assert payload["error"] == "permission_denied"
    assert payload["policy_layer"] == "mode_special"
    assert payload["reason_code"] == "ask_task_readonly_required"
    assert "readonly=true" in str(payload["reason_text"])


def test_ask_mode_allows_task_when_readonly(monkeypatch):
    monkeypatch.setattr(
        mode_permission_module,
        "explain_tool_policy_by_level",
        lambda **kwargs: {
            "allowed": True,
            "policy_layer": "autonomy",
            "reason_code": "autonomy_default_allow",
            "reason_text": "autonomy allow",
        },
    )
    middleware = ModePermissionMiddleware()
    request = SimpleNamespace(
        tool_call={
            "id": "call-3",
            "name": "task",
            "args": {"subagent_type": "explore", "readonly": True},
        },
        state={"mode": "ask"},
        runtime=SimpleNamespace(context={"configurable": {}}),
    )
    result = middleware.wrap_tool_call(request, lambda _request: ToolMessage(content="ok", tool_call_id="call-3", name="task"))
    assert isinstance(result, ToolMessage)
    assert result.content == "ok"


def test_permission_precedence_mode_before_autonomy(monkeypatch):
    middleware = ModePermissionMiddleware()
    monkeypatch.setattr(
        mode_permission_module,
        "explain_tool_policy_decision",
        lambda mode, tool_name: {
            "allowed": False,
            "policy_layer": "mode",
            "reason_code": "mode_allowlist_miss",
            "reason_text": "mode blocked",
        },
    )
    monkeypatch.setattr(
        mode_permission_module,
        "explain_tool_policy_by_level",
        lambda **kwargs: {
            "allowed": False,
            "policy_layer": "autonomy",
            "reason_code": "autonomy_l1_write_tool_block",
            "reason_text": "autonomy blocked",
        },
    )
    request = SimpleNamespace(
        tool_call={"id": "call-4", "name": "write_file", "args": {"path": "a.txt", "content": "x"}},
        state={"mode": "ask"},
        runtime=SimpleNamespace(context={"configurable": {}}),
    )
    result = middleware.wrap_tool_call(request, lambda _request: ToolMessage(content="ok", tool_call_id="call-4", name="write_file"))
    payload = json.loads(str(result.content))
    assert payload["policy_layer"] == "mode"
    assert payload["reason_code"] == "mode_allowlist_miss"
