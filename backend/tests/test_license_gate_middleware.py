"""License gate middleware: 允许/拒绝路径与错误信息可断言。"""
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.engine.middleware.license_gate_middleware import LicenseGateMiddleware
from langchain_core.messages import ToolMessage


class _ToolCallRequest:
    def __init__(self, tool_call):
        self.tool_call = tool_call


def test_license_gate_allowed_tool_passes_to_handler():
    """当工具在允许列表中时，调用 handler。"""
    middleware = LicenseGateMiddleware()
    with patch.object(middleware, "_allowed_tools", return_value={"read_file", "write_file"}):
        with patch.object(middleware, "_current_tier", return_value="free"):
            captured = []

            def handler(req):
                captured.append(req)
                return ToolMessage(content="ok", tool_call_id="id1", name="read_file")

            req = _ToolCallRequest(tool_call={"name": "read_file", "id": "id1"})
            out = middleware.wrap_tool_call(req, handler)
            assert len(captured) == 1
            assert out.content == "ok"


def test_license_gate_denied_tool_returns_tool_message():
    """当工具不在允许列表且非 * 时，返回 ToolMessage 且包含 [LicenseGate]。"""
    middleware = LicenseGateMiddleware()
    with patch.object(middleware, "_allowed_tools", return_value={"read_file"}):
        with patch.object(middleware, "_current_tier", return_value="free"):
            def handler(req):
                raise AssertionError("handler 不应被调用")

            req = _ToolCallRequest(tool_call={"name": "write_file", "id": "id1"})
            out = middleware.wrap_tool_call(req, handler)
            assert isinstance(out, ToolMessage)
            assert "[LicenseGate]" in (out.content or "")
            assert out.tool_call_id == "id1"
            assert out.name == "write_file"


def test_license_gate_star_allows_all():
    """当 _allowed_tools 含 '*' 时，任意工具放行。"""
    middleware = LicenseGateMiddleware()
    with patch.object(middleware, "_allowed_tools", return_value={"*"}):
        captured = []

        def handler(req):
            captured.append(req)
            return ToolMessage(content="ok", tool_call_id="id1", name="any_tool")

        req = _ToolCallRequest(tool_call={"name": "any_tool", "id": "id1"})
        out = middleware.wrap_tool_call(req, handler)
        assert len(captured) == 1
        assert out.content == "ok"
