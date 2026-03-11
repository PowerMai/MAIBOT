"""
每次执行写文档契约 - 实现层

在任务/会话结束后写入 .maibot/execution_summary.md（及可选 lessons.md），
满足 docs/execution_document_contract.md 约定。
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_ENABLE_KEY = "ENABLE_EXECUTION_DOCS"
_MAX_SUMMARY_LINES = 500
_MAX_LESSON_LINES = 300


def _workspace_root(workspace_path: Optional[str] = None) -> Path:
    if workspace_path and workspace_path.strip():
        p = Path(workspace_path).expanduser().resolve()
        if p.is_dir():
            return p
    try:
        from backend.tools.base.paths import get_workspace_root
        return get_workspace_root()
    except Exception:
        return Path.cwd()


def write_execution_summary(
    workspace_path: Optional[str],
    task_id: str,
    thread_id: str,
    result_summary: str,
) -> bool:
    """
    在工作区 .maibot/execution_summary.md 追加一条执行摘要。

    契约见 docs/execution_document_contract.md。
    若 ENABLE_EXECUTION_DOCS 不为 true 则跳过写入。
    """
    if os.getenv(_ENABLE_KEY, "").strip().lower() != "true":
        return False
    root = _workspace_root(workspace_path)
    path = root / ".maibot" / "execution_summary.md"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
        block = f"\n## {ts}\n- task_id: {task_id}\n- thread_id: {thread_id}\n- summary: {result_summary.strip()[:2000]}\n"
        if path.exists():
            content = path.read_text(encoding="utf-8")
            lines = (content + block).splitlines()
            if len(lines) > _MAX_SUMMARY_LINES:
                content = "\n".join(lines[-_MAX_SUMMARY_LINES:]) + "\n"
            else:
                content = content + block
        else:
            content = f"# Execution Summary\n{block}"
        path.write_text(content, encoding="utf-8")
        return True
    except Exception as e:
        logger.debug("write_execution_summary failed: %s", e)
        return False


def write_lesson(
    workspace_path: Optional[str],
    task_id: str,
    thread_id: str,
    summary: str,
    error: Optional[str] = None,
    suggestion: Optional[str] = None,
) -> bool:
    """
    在工作区 .maibot/lessons.md 追加一条经验/教训。契约见 execution_document_contract.md。
    """
    if os.getenv(_ENABLE_KEY, "").strip().lower() != "true":
        return False
    root = _workspace_root(workspace_path)
    path = root / ".maibot" / "lessons.md"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
        block = f"\n## {ts}\n- task_id: {task_id}\n- thread_id: {thread_id}\n- summary: {summary.strip()[:1000]}\n"
        if error:
            block += f"- error: {error.strip()[:500]}\n"
        if suggestion:
            block += f"- suggestion: {suggestion.strip()[:500]}\n"
        if path.exists():
            content = path.read_text(encoding="utf-8")
            lines = (content + block).splitlines()
            if len(lines) > _MAX_LESSON_LINES:
                content = "\n".join(lines[-_MAX_LESSON_LINES:]) + "\n"
            else:
                content = content + block
        else:
            content = f"# Lessons\n{block}"
        path.write_text(content, encoding="utf-8")
        return True
    except Exception as e:
        logger.debug("write_lesson failed: %s", e)
        return False
