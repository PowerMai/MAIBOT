"""任务模块共享 Store 访问入口。"""

from __future__ import annotations

from typing import Any

from backend.config.store_namespaces import (
    NS_BOARD_ORG,
    NS_BOARD_PERSONAL,
    NS_BOARD_PUBLIC,
)


def get_task_store() -> Any:
    """统一获取任务域 sqlite store。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store

        return get_sqlite_store()
    except Exception:
        return None


def board_ns_for_scope(scope: str) -> tuple:
    normalized = str(scope or "personal").strip().lower()
    if normalized == "org":
        return NS_BOARD_ORG
    if normalized == "public":
        return NS_BOARD_PUBLIC
    return NS_BOARD_PERSONAL
