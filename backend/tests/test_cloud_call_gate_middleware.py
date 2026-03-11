"""Cloud call gate middleware: 无敏感路径时放行，敏感路径可脱敏。"""
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from backend.engine.middleware.cloud_call_gate_middleware import CloudCallGateMiddleware


def test_cloud_call_gate_load_sensitive_patterns_missing_file():
    """settings 文件不存在时，_load_sensitive_patterns 返回空列表。"""
    with patch.object(CloudCallGateMiddleware, "__init__", lambda self: None):
        m = CloudCallGateMiddleware()
        m.settings_path = Path("/nonexistent/.maibot/settings.json")
        m._patterns_cache = None
        m._patterns_mtime = 0
    out = m._load_sensitive_patterns()
    assert out == []


def test_cloud_call_gate_before_model_empty_messages_returns_none():
    """before_model 在 messages 为空时返回 None（不注入）。"""
    with patch("backend.engine.middleware.cloud_call_gate_middleware.get_workspace_root", return_value=Path("/tmp")):
        m = CloudCallGateMiddleware()
    state = {"messages": []}
    runtime = MagicMock()
    out = m.before_model(state, runtime)
    assert out is None
