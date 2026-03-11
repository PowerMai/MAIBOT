"""
用户 AI 杠杆率追踪（AI Leverage Score）

追踪：任务迭代次数、工具使用广度、任务完成率，用于度量用户通过 AI 解决问题的能力。
存储于 LangGraph Store，命名空间 ("user_leverage", workspace_id)。
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

from backend.config.store_namespaces import ns_user_leverage

logger = logging.getLogger(__name__)

LEVERAGE_KEY = "metrics"
_MAX_ITERATION_HISTORY = 100
_MAX_TOOL_NAMES = 200


def get_leverage(store: Any, workspace_id: str) -> Dict[str, Any]:
    """从 Store 读取当前工作区的杠杆率指标。"""
    if store is None:
        return _default_leverage()
    try:
        ns = ns_user_leverage(workspace_id or "default")
        item = store.get(ns, LEVERAGE_KEY)
        if item and isinstance(item.value, dict):
            return {**_default_leverage(), **item.value}
    except Exception as e:
        logger.debug("get_leverage: %s", e)
    return _default_leverage()


def _default_leverage() -> Dict[str, Any]:
    return {
        "task_count": 0,
        "total_iterations": 0,
        "completed_count": 0,
        "tool_names": [],
        "last_updated": None,
    }


def record_task_start(store: Any, workspace_id: str) -> None:
    """记录一次任务开始（用于后续计算迭代次数）。"""
    data = get_leverage(store, workspace_id)
    data["task_count"] = data.get("task_count", 0) + 1
    data["last_updated"] = datetime.now(timezone.utc).isoformat()
    _put_leverage(store, workspace_id, data)


def record_task_iteration(
    store: Any,
    workspace_id: str,
    tool_names_used: List[str],
) -> None:
    """记录一次任务迭代（多轮对话中的一轮），并更新工具使用集合。"""
    data = get_leverage(store, workspace_id)
    data["total_iterations"] = data.get("total_iterations", 0) + 1
    names: Set[str] = set(data.get("tool_names") or [])
    for n in tool_names_used:
        if n and isinstance(n, str):
            names.add(n)
    data["tool_names"] = list(names)[:_MAX_TOOL_NAMES]
    data["last_updated"] = datetime.now(timezone.utc).isoformat()
    _put_leverage(store, workspace_id, data)


def record_task_completed(store: Any, workspace_id: str, accepted: bool = True) -> None:
    """记录任务完成（是否被用户接受）。"""
    data = get_leverage(store, workspace_id)
    if accepted:
        data["completed_count"] = data.get("completed_count", 0) + 1
    data["last_updated"] = datetime.now(timezone.utc).isoformat()
    _put_leverage(store, workspace_id, data)


def _put_leverage(store: Any, workspace_id: str, data: Dict[str, Any]) -> None:
    if store is None:
        return
    try:
        ns = ns_user_leverage(workspace_id or "default")
        store.put(ns, LEVERAGE_KEY, data)
    except Exception as e:
        logger.warning("_put_leverage: %s", e)


def compute_leverage_score(leverage: Dict[str, Any]) -> float:
    """
    计算 AI 杠杆率得分（0~1 归一化）。
    有效产出 / (任务数 × 迭代轮次) 的单调变换，再结合工具广度。
    """
    task_count = max(1, leverage.get("task_count", 0))
    total_iterations = max(1, leverage.get("total_iterations", 0))
    completed = leverage.get("completed_count", 0)
    tool_breadth = len(leverage.get("tool_names") or [])
    # 完成率
    completion_rate = completed / task_count if task_count else 0.0
    # 迭代效率：迭代越少完成越多越好
    avg_iter = total_iterations / task_count if task_count else 0
    iter_efficiency = 1.0 / (1.0 + avg_iter) if avg_iter else 0.0
    # 工具广度奖励（上限 0.2）
    breadth_bonus = min(0.2, tool_breadth * 0.01)
    score = 0.5 * completion_rate + 0.3 * iter_efficiency + 0.2 + breadth_bonus
    return round(min(1.0, max(0.0, score)), 3)
