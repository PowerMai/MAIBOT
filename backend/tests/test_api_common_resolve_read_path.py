"""API common.resolve_read_path 与 app 中 _resolve_read_path 的导入与行为测试。"""
from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from backend.api import common


def test_resolve_read_path_empty_raises_400():
    """空 path 应抛出 400。"""
    with pytest.raises(HTTPException) as exc_info:
        common.resolve_read_path("")
    assert exc_info.value.status_code == 400
    assert "path" in (exc_info.value.detail or "").lower()


def test_resolve_read_path_whitespace_only_raises_400():
    """仅空格的 path 应抛出 400。"""
    with pytest.raises(HTTPException) as exc_info:
        common.resolve_read_path("   ")
    assert exc_info.value.status_code == 400


def test_resolve_read_path_returns_path_for_existing_file_under_workspace():
    """工作区下存在的文件应解析为 Path。"""
    with tempfile.TemporaryDirectory() as tmp:
        ws = Path(tmp).resolve()  # 统一为 resolve 后的路径，避免 macOS /private/var 与 /var 不一致
        f = ws / "foo.txt"
        f.write_text("hello", encoding="utf-8")
        with patch("backend.api.common.get_workspace_root", return_value=ws):
            resolved = common.resolve_read_path("foo.txt")
        assert resolved == f.resolve()
        assert resolved.is_file()


def test_app_imports_resolve_read_path_as_resolve_read_path():
    """app 模块应能导入 resolve_read_path（别名为 _resolve_read_path），供 multimodal/vision/analyze 使用。"""
    import importlib
    try:
        # 使用 import_module 获取模块对象；'import backend.api.app' 得到的是包导出的 FastAPI 实例
        app_module = importlib.import_module("backend.api.app")
    except Exception as e:
        pytest.skip(f"backend.api.app 在测试环境中无法完整加载: {e}")
    fn = getattr(app_module, "_resolve_read_path", None)
    assert fn is not None, "backend.api.app 必须提供 _resolve_read_path 供 /multimodal/vision/analyze 使用"
    assert fn is common.resolve_read_path, "_resolve_read_path 应为 common.resolve_read_path"


def test_resolve_write_path_forbidden_backend_config_raises_403():
    """resolve_write_path 禁止写入 backend/config 下路径，与 resolve_read_path 一致。"""
    with tempfile.TemporaryDirectory() as tmp:
        ws = Path(tmp).resolve()
        with patch("backend.api.common.get_workspace_root", return_value=ws), patch(
            "backend.api.common.get_project_root", return_value=ws
        ):
            with pytest.raises(HTTPException) as exc_info:
                common.resolve_write_path("backend/config/foo.txt")
            assert exc_info.value.status_code == 403
            assert "not allowed" in (exc_info.value.detail or "").lower()
