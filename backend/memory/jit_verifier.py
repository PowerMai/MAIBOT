"""
JIT (Just-In-Time) 验证器 - Copilot 式引用验证

使用记忆时实时验证 citation 仍与当前文件一致；
不一致则可由调用方触发记忆更新（self-healing memory pool）。

参考：GitHub Copilot agentic memory (2026) — 带引用的记忆 + 实时验证。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _normalize_content(s: str) -> str:
    """标准化文本便于比较（去除末尾空白、统一换行）。"""
    if not s:
        return ""
    return "\n".join(line.rstrip() for line in s.rstrip().splitlines())


def get_content_at_citation(
    citation: dict[str, Any],
    workspace_path: str = "",
    encoding: str = "utf-8",
) -> Optional[str]:
    """
    读取 citation 指向的文件行区间内容。

    Args:
        citation: {"file": path, "line_start": int, "line_end": int}
        workspace_path: 工作区根路径，用于解析相对路径
        encoding: 文件编码

    Returns:
        该区间的文本，失败返回 None
    """
    if not citation or not citation.get("file"):
        return None
    path_str = citation["file"].strip()
    line_start = max(1, int(citation.get("line_start", 1)))
    line_end = max(line_start, int(citation.get("line_end", line_start)))

    path = Path(path_str)
    if not path.is_absolute() and workspace_path:
        path = Path(workspace_path) / path_str
    if not path.exists() or not path.is_file():
        logger.debug("JIT verifier: file not found %s", path)
        return None
    try:
        lines = path.read_text(encoding=encoding).splitlines()
        # 1-based to 0-based
        start = max(0, line_start - 1)
        end = min(len(lines), line_end)
        if start >= end:
            return ""
        return "\n".join(lines[start:end])
    except Exception as e:
        logger.warning("JIT verifier: read failed %s: %s", path, e)
        return None


def verify_citation(
    citation: dict[str, Any],
    expected_content: str,
    workspace_path: str = "",
    normalize: bool = True,
) -> bool:
    """
    验证 citation 指向的当前文件内容是否与 expected_content 一致。

    Args:
        citation: {"file": path, "line_start": int, "line_end": int}
        expected_content: 记忆/检索结果中保存的内容
        workspace_path: 工作区根路径
        normalize: 是否标准化后再比较

    Returns:
        True 表示一致，False 表示不一致或无法读取
    """
    current = get_content_at_citation(citation, workspace_path=workspace_path)
    if current is None:
        return False
    if normalize:
        current = _normalize_content(current)
        expected_content = _normalize_content(expected_content)
    return current == expected_content
