"""工作区路径解析：get_workspace_root 失败时不降级到 cwd，返回明确错误。"""
from __future__ import annotations

import importlib
from pathlib import Path
from unittest.mock import patch

# 从实现模块取 _resolve_workspace_path（nodes/__init__ 只导出 editor_tool_node 函数，会遮蔽子模块）
_editor_tool_module = importlib.import_module("backend.engine.nodes.editor_tool_node")


def test_resolve_workspace_path_when_get_workspace_root_raises():
    """get_workspace_root() 抛异常时，应返回 (None, 错误信息)，不降级到 cwd。"""
    with patch("backend.tools.base.paths.get_workspace_root", side_effect=RuntimeError("no workspace")):
        path, err = _editor_tool_module._resolve_workspace_path("foo/bar.txt")
    assert path is None
    assert err is not None
    assert "工作区根目录获取失败" in err


def test_resolve_workspace_path_empty_file_path():
    """file_path 为空时返回 (None, 缺少 file_path)。"""
    with patch("backend.tools.base.paths.get_workspace_root", return_value=Path("/ws")):
        path, err = _editor_tool_module._resolve_workspace_path("")
    assert path is None
    assert "缺少 file_path" in (err or "")
