"""Mode permission middleware: Ask 模式拒绝写文件类工具，Agent 模式允许只读工具。"""
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from backend.engine.middleware.mode_permission_middleware import ModePermissionMiddleware
from langchain_core.messages import ToolMessage


class _ToolCallRequest:
    def __init__(self, tool_call, state=None, runtime=None):
        self.tool_call = tool_call
        self.state = state or {}
        self.runtime = runtime


def test_mode_permission_ask_blocks_write_file():
    """Ask 模式下 write_file 应被拒绝，返回 ToolMessage 含 permission_denied。"""
    root = Path(__file__).resolve().parents[2]
    with patch("backend.engine.middleware.mode_permission_middleware.get_workspace_root", return_value=root):
        m = ModePermissionMiddleware()
    req = _ToolCallRequest(
        tool_call={"name": "write_file", "args": {}, "id": "tid1"},
        state={"mode": "ask"},
    )
    req.runtime = MagicMock()
    req.runtime.context = {"configurable": {"mode": "ask"}}

    def handler(r):
        return ToolMessage(content="written", tool_call_id="tid1", name="write_file")

    out = m.wrap_tool_call(req, handler)
    assert isinstance(out, ToolMessage)
    assert "permission_denied" in (out.content or "")
    try:
        data = json.loads(out.content)
        assert data.get("allowed") is False
        assert data.get("reason_code")
    except json.JSONDecodeError:
        assert "permission_denied" in (out.content or "")
