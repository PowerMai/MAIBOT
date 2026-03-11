"""任务中继（A2A / 多角色委派）最小闭环实现。"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

from backend.config.store_namespaces import (
    NS_BOARD_RELAY_INDEX,
)
from backend.engine.tasks.task_bidding import project_board_task_status
from backend.engine.tasks.store_access import get_task_store, board_ns_for_scope


def _get_store():
    return get_task_store()


def _board_ns_for_scope(scope: str) -> tuple:
    return board_ns_for_scope(scope)


_ACCEPT_ALLOWED_STATUSES = {"available", "bidding", "claimed"}
_COMPLETE_ALLOWED_STATUSES = {"running", "in_progress"}


def _relay_index_key(scope: str, relay_id: str) -> str:
    return f"{str(scope or 'personal').strip().lower()}::{str(relay_id or '').strip()}"


def _upsert_relay_index(store: Any, scope: str, relay_id: str, task_id: str) -> None:
    key = _relay_index_key(scope, relay_id)
    store.put(
        NS_BOARD_RELAY_INDEX,
        key,
        {
            "relay_id": str(relay_id),
            "task_id": str(task_id),
            "scope": str(scope or "personal"),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )


def _resolve_task_by_relay_id(store: Any, scope: str, relay_id: str) -> tuple[Optional[str], Optional[Dict[str, Any]]]:
    ns = _board_ns_for_scope(scope)
    relay_id_norm = str(relay_id or "").strip()
    if not relay_id_norm:
        return None, None

    # Fast path: relay_id index -> task_id
    try:
        idx_out = store.get(NS_BOARD_RELAY_INDEX, _relay_index_key(scope, relay_id_norm))
        if idx_out:
            idx_val = getattr(idx_out, "value", idx_out) if not isinstance(idx_out, dict) else idx_out
            if isinstance(idx_val, dict):
                task_id = str(idx_val.get("task_id") or "").strip()
                if task_id:
                    task_out = store.get(ns, task_id)
                    if task_out:
                        task_val = getattr(task_out, "value", task_out) if not isinstance(task_out, dict) else task_out
                        task_dict = dict(task_val) if isinstance(task_val, dict) else {}
                        if str(task_dict.get("relay_id") or "").strip() == relay_id_norm:
                            return task_id, task_dict
    except Exception:
        pass

    # Backward compatible path: scan old records once, then heal index
    for key in list(store.list(ns)):
        out = store.get(ns, key)
        if not out:
            continue
        v = getattr(out, "value", out) if not isinstance(out, dict) else out
        val = dict(v) if isinstance(v, dict) else {}
        if str(val.get("relay_id") or "").strip() != relay_id_norm:
            continue
        try:
            _upsert_relay_index(store, scope, relay_id_norm, str(key))
        except Exception:
            pass
        return str(key), val
    return None, None


def relay_task(
    task_id: str,
    from_role: str,
    to_role: str,
    context: Optional[Dict[str, Any]] = None,
    relay_type: str = "delegate",
    scope: str = "personal",
) -> Dict[str, Any]:
    """将任务标记为已中继，并写入中继元数据。"""
    store = _get_store()
    if store is None:
        return {"ok": False, "error": "Store 不可用"}
    ns = _board_ns_for_scope(scope)
    out = store.get(ns, task_id)
    if not out:
        return {"ok": False, "error": "任务不存在"}
    v = getattr(out, "value", out) if not isinstance(out, dict) else out
    val = dict(v) if isinstance(v, dict) else {}
    current_status = str(val.get("status") or "").strip().lower()
    if current_status in {"completed", "failed", "cancelled", "paused"}:
        return {"ok": False, "error": f"当前状态不允许 relay: {current_status or 'unknown'}"}
    relay_id = str(val.get("relay_id") or f"relay-{uuid.uuid4()}")
    now = datetime.now(timezone.utc).isoformat()
    val["relay_id"] = relay_id
    val["origin_role"] = from_role
    val["target_role"] = to_role
    val["relay_type"] = relay_type
    val["relay_status"] = "invited"
    val["relay_context"] = context or {}
    val["state_version"] = int(val.get("state_version") or 0) + 1
    val["updated_at"] = now
    store.put(ns, task_id, val)
    try:
        _upsert_relay_index(store, scope, relay_id, task_id)
    except Exception:
        pass
    return {"ok": True, "relay_id": relay_id, "task_id": task_id}


def accept_relay(relay_id: str, accepting_role: str, scope: str = "personal") -> Dict[str, Any]:
    """按 relay_id 接受中继任务。"""
    store = _get_store()
    if store is None:
        return {"ok": False, "error": "Store 不可用"}
    task_id, val = _resolve_task_by_relay_id(store, scope, relay_id)
    if task_id and isinstance(val, dict):
        current_status = str(val.get("status") or "").strip().lower()
        if current_status not in _ACCEPT_ALLOWED_STATUSES:
            return {"ok": False, "error": f"当前状态不允许接受 relay: {current_status or 'unknown'}"}
        existing_claimed_by = str(val.get("claimed_by") or "").strip()
        if current_status == "claimed" and existing_claimed_by and existing_claimed_by != accepting_role:
            return {"ok": False, "error": f"任务已被其他角色认领: {existing_claimed_by}"}
        try:
            projected = project_board_task_status(
                task_id=task_id,
                status="claimed",
                scope=scope,
                thread_id=str(val.get("thread_id") or "") or None,
                progress=(int(val.get("progress")) if isinstance(val.get("progress"), (int, float)) else None),
                progress_message=str(val.get("progress_message") or ""),
                dispatch_state=str(val.get("dispatch_state") or "") or None,
                claimed_by=accepting_role,
                source="relay_accept",
                only_when_status_in=_ACCEPT_ALLOWED_STATUSES,
                only_when_claimed_by=(existing_claimed_by if existing_claimed_by else ""),
                extra_updates={"relay_status": "accepted"},
            )
            if not projected:
                return {"ok": False, "error": "relay 状态写入失败（可能被并发修改）"}
        except Exception as e:
            logger.exception("accept_relay 状态写入异常: %s", e)
            return {"ok": False, "error": "relay 状态写入异常"}
        return {"ok": True, "task_id": task_id}
    return {"ok": False, "error": "relay 不存在"}


def complete_relay(relay_id: str, result: str, scope: str = "personal") -> Dict[str, Any]:
    """完成中继任务并回写结果。"""
    store = _get_store()
    if store is None:
        return {"ok": False, "error": "Store 不可用"}
    task_id, val = _resolve_task_by_relay_id(store, scope, relay_id)
    if task_id and isinstance(val, dict):
        current_status = str(val.get("status") or "").strip().lower()
        if current_status not in _COMPLETE_ALLOWED_STATUSES:
            return {"ok": False, "error": f"当前状态不允许完成 relay: {current_status or 'unknown'}"}
        normalized_result = (result or "")[:5000]
        try:
            projected = project_board_task_status(
                task_id=task_id,
                status="completed",
                scope=scope,
                thread_id=str(val.get("thread_id") or "") or None,
                result=normalized_result,
                progress=(int(val.get("progress")) if isinstance(val.get("progress"), (int, float)) else 100),
                progress_message=str(val.get("progress_message") or ""),
                dispatch_state=str(val.get("dispatch_state") or "") or None,
                claimed_by=(str(val.get("claimed_by") or "") or None),
                source="relay_complete",
                only_when_status_in=_COMPLETE_ALLOWED_STATUSES,
                only_when_claimed_by=(str(val.get("claimed_by") or "").strip()),
                extra_updates={"relay_status": "completed"},
            )
            if not projected:
                return {"ok": False, "error": "relay 状态写入失败（可能被并发修改）"}
        except Exception as e:
            logger.exception("complete_relay 状态写入异常: %s", e)
            return {"ok": False, "error": "relay 状态写入异常"}
        return {"ok": True, "task_id": task_id}
    return {"ok": False, "error": "relay 不存在"}

