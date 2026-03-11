"""
Board 与任务看板相关 API：任务 CRUD、执行状态、竞标、人工审核、能力与连接。
从 app.py 拆出，通过 APIRouter 挂载。
"""
from fastapi import APIRouter, HTTPException, Body, Request, Depends, Query
import hmac
import ipaddress
import json
import logging
import asyncio
import os
import threading
import time
import uuid as uuid_module
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import deque
from typing import List, Dict, Any, Optional, Union
from urllib.parse import urlparse, quote as _url_quote

from backend.api.common import is_valid_thread_id_uuid
from backend.api.deps import get_api_project_root, get_api_current_tier, verify_internal_token, VALID_BOARD_SCOPES
from backend.config.store_namespaces import NS_BOARD_PERSONAL, NS_BOARD_ORG, NS_BOARD_PUBLIC, NS_BOARD_INVITES
from backend.utils.security import is_safe_callback_url as _is_safe_callback_url
from pydantic import BaseModel, Field, field_validator
import httpx

router = APIRouter()

logger = logging.getLogger(__name__)

_IDEMPOTENCY_CACHE_MAX = 500
_IDEMPOTENCY_CACHE_TTL_SEC = max(60, int(os.environ.get("IDEMPOTENCY_CACHE_TTL_SEC", "300")))
_idempotency_create_cache: Dict[tuple, tuple[str, float]] = {}  # (scope, key) -> (task_id, ts)
_idempotency_cache_keys: deque = deque()  # FIFO order for eviction, O(1) popleft
_idempotency_create_lock = asyncio.Lock()
_board_jsonl_append_lock = threading.Lock()

# 核心引擎验收：board_update_task 状态写入冲突率可观测（Phase 3）
_board_patch_status_attempts: int = 0
_board_patch_status_conflicts: int = 0
_board_patch_lock = asyncio.Lock()

# Board 列表短期缓存，降低重复全量扫描（TTL 5s，仅按 scope 缓存原始 rows）
_BOARD_LIST_CACHE_TTL_SEC = 5.0
_board_list_cache: Dict[str, tuple[float, List[Dict[str, Any]]]] = {}
_board_list_cache_max_entries = 8


def _safe_error_detail(e: Exception) -> str:
    """生产环境不暴露内部异常详情，仅开发环境返回 str(e)。"""
    if os.getenv("APP_ENV", "production") == "development":
        return str(e)
    return "内部服务器错误"


def _validate_task_id(task_id: str) -> str:
    """校验 path 中的 task_id 为合法 UUID，否则 422。"""
    try:
        uuid_module.UUID(task_id)
        return task_id
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail="invalid task_id format")


def _verify_a2a_secret(request: Request) -> None:
    """若未配置 A2A_SHARED_SECRET 则 503；若已配置则要求请求头 X-Agent-Secret 与之一致，否则 401。"""
    secret = os.environ.get("A2A_SHARED_SECRET", "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="A2A 功能未启用：未配置 A2A_SHARED_SECRET")
    header = (request.headers.get("X-Agent-Secret") or "").strip()
    if not header or not hmac.compare_digest(header, secret):
        raise HTTPException(status_code=401, detail="invalid or missing X-Agent-Secret")


# ============================================================

class TaskCreateRequest(BaseModel):
    subject: str
    description: Optional[str] = ""
    priority: Optional[int] = 3
    scene: Optional[str] = "full"
    mode: Optional[str] = "agent"
    skill_profile: Optional[str] = None
    use_router: Optional[bool] = False
    required_skills: Optional[List[str]] = None
    background: Optional[bool] = False
    webhook: Optional[str] = None
    workspace_path: Optional[str] = None


@router.post("/tasks")
async def api_create_task(req: TaskCreateRequest, _: None = Depends(verify_internal_token)):
    """创建并执行任务（创建带 metadata 的 thread + 启动 run）。use_router=True 时按 subject/required_skills 推荐角色并设置 skill_profile。"""
    try:
        from backend.engine.tasks.task_service import create_task
        config = {
            "scene": req.scene or "full",
            "mode": req.mode or "agent",
            "skill_profile": req.skill_profile or req.scene or "full",
            "license_tier": get_api_current_tier(),
        }
        if req.workspace_path and str(req.workspace_path).strip():
            config["workspace_path"] = str(req.workspace_path).strip()
        result = await create_task(
            subject=req.subject,
            description=(req.description or "").strip() or req.subject,
            config=config,
            priority=req.priority or 3,
            use_router=req.use_router or False,
            required_skills=req.required_skills,
            background=req.background or False,
            webhook=req.webhook,
        )
        return {"ok": True, **result}
    except Exception as e:
        logger.exception("创建任务失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


def _project_board_row_to_thread(row: Dict[str, Any]) -> Dict[str, Any]:
    """将看板任务行投影为 /tasks 接口的 thread 形态（TASK_STATUS_AUTHORITY=board 时用）。"""
    tid = str(row.get("task_id") or row.get("id") or "").strip()
    return {
        "thread_id": tid,
        "metadata": {
            "is_task": True,
            "task_status": row.get("status"),
            "subject": row.get("subject"),
            "priority": row.get("priority"),
            "scene": row.get("scene"),
            "mode": row.get("mode"),
            "scope": row.get("scope", "personal"),
            "deliverables": row.get("deliverables"),
            "parent_task_id": row.get("parent_task_id"),
            "created_by": row.get("created_by"),
            "result_summary": row.get("result_summary"),
            "error": row.get("error"),
            "task_status_history": row.get("task_status_history"),
            "execution": row.get("execution"),
            "recovery_point": row.get("recovery_point"),
            "completed_step_ids": row.get("completed_step_ids"),
            "role_id": row.get("role_id"),
            "claimed_by": row.get("claimed_by"),
            "blocked_reason": row.get("blocked_reason"),
        },
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


@router.get("/tasks")
async def api_list_tasks(
    status: Optional[str] = None,
    limit: int = 50,
    workspace_path: Optional[str] = Query(None, description="按工作区过滤，仅返回该工作区或未设置工作区的任务"),
):
    """列出任务（?status=pending&limit=50&workspace_path=...）。TASK_STATUS_AUTHORITY=board 时从看板投影。limit 上限 200。"""
    try:
        limit = min(max(1, limit or 50), 200)
        wp = str(workspace_path or "").strip() or None
        from backend.engine.tasks.task_bidding import get_task_status_authority
        if get_task_status_authority() == "board":
            from backend.engine.core.main_graph import get_sqlite_store
            store = get_sqlite_store()
            if store is None:
                return {"ok": True, "tasks": []}
            ns = _board_ns_for_scope("personal")
            cap = max(1, min(limit, 100))
            rows = await _store_list_items(store, ns, limit=min(cap * 2, 500))
            allowed = None
            if status is not None:
                allowed = {status}
                if status == "pending":
                    allowed = {"pending", "available"}
            out = []
            for row in rows:
                if allowed is None or row.get("status") in allowed:
                    if wp:
                        row_wp = str(row.get("workspace_path") or "").strip()
                        if row_wp and row_wp != wp:
                            continue
                    out.append(_project_board_row_to_thread(row))
            out.sort(key=lambda x: (x.get("updated_at") or x.get("created_at") or ""), reverse=True)
            return {"ok": True, "tasks": out[:cap]}
        from backend.engine.tasks.task_service import list_tasks
        tasks = await list_tasks(status=status, limit=limit, workspace_path=wp)
        return {"ok": True, "tasks": tasks}
    except Exception as e:
        logger.exception("列出任务失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.get("/tasks/{thread_id}")
async def api_get_task(thread_id: str):
    """任务详情（含执行状态和 state）。TASK_STATUS_AUTHORITY=board 时从看板投影。"""
    try:
        from backend.engine.tasks.task_bidding import get_task_status_authority
        from backend.engine.tasks.task_service import get_task, TaskNotFoundError
        if get_task_status_authority() == "board":
            from backend.engine.core.main_graph import get_sqlite_store
            store = get_sqlite_store()
            if store is None:
                raise HTTPException(status_code=404, detail="任务不存在")
            for scope in ("personal", "org", "public"):
                ns = _board_ns_for_scope(scope)
                out = await _store_get(store, ns, thread_id)
                if not out:
                    continue
                v = getattr(out, "value", out) if not isinstance(out, dict) else out
                val = dict(v) if isinstance(v, dict) else {}
                if not val:
                    continue
                val.setdefault("id", thread_id)
                val.setdefault("task_id", thread_id)
                task = _project_board_row_to_thread(val)
                task["state"] = {}
                return {"ok": True, "task": task}
            raise HTTPException(status_code=404, detail="任务不存在")
        task = await get_task(thread_id)
        return {"ok": True, "task": task}
    except HTTPException:
        raise
    except ValueError as e:
        if "thread_id" in str(e).lower():
            raise HTTPException(status_code=422, detail="invalid thread_id format")
        raise HTTPException(status_code=422, detail=_safe_error_detail(e))
    except TaskNotFoundError as e:
        raise HTTPException(status_code=404, detail=_safe_error_detail(e))
    except Exception as e:
        logger.exception("获取任务失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


_API_UPDATE_TASK_BODY_KEYS = frozenset({
    "task_status", "subject", "priority", "scene", "mode", "deliverables",
    "parent_task_id", "created_by", "result_summary", "error", "task_status_history",
    "execution", "recovery_point", "completed_step_ids", "is_task",
})


@router.patch("/tasks/{thread_id}")
async def api_update_task(thread_id: str, body: dict = Body(default={}), _: None = Depends(verify_internal_token)):
    """更新任务（取消、标记完成等）；若 task_status=cancelled 则先取消 run。"""
    unknown = [k for k in body if k not in _API_UPDATE_TASK_BODY_KEYS]
    if unknown:
        raise HTTPException(status_code=422, detail=f"不允许的字段: {unknown}")
    try:
        from backend.engine.tasks.task_service import update_task, cancel_task, get_task, TaskNotFoundError
        if body.get("task_status") == "cancelled":
            try:
                current = await get_task(thread_id)
                if isinstance(current, dict):
                    meta = current.get("metadata") or {}
                    status = meta.get("task_status") if isinstance(meta, dict) else None
                    if status == "cancelled":
                        return {"ok": True, "task": current, "already_cancelled": True}
            except TaskNotFoundError:
                pass
            result = await cancel_task(thread_id)
        else:
            result = await update_task(thread_id, **body)
        return {"ok": True, "task": result}
    except ValueError as e:
        if "thread_id" in str(e).lower():
            raise HTTPException(status_code=422, detail="invalid thread_id format")
        raise HTTPException(status_code=422, detail=_safe_error_detail(e))
    except TaskNotFoundError as e:
        raise HTTPException(status_code=404, detail=_safe_error_detail(e))
    except Exception as e:
        logger.exception("更新任务失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


# ============================================================
# 看板 API（多级任务看板，Phase 1 仅个人）
# ============================================================

def _board_ns_for_scope(scope: str) -> tuple:
    if scope == "org":
        return NS_BOARD_ORG
    if scope == "public":
        return NS_BOARD_PUBLIC
    return NS_BOARD_PERSONAL


def _extract_store_key(item: Any) -> Optional[str]:
    if isinstance(item, tuple) and len(item) >= 1:
        return str(item[0])
    if isinstance(item, dict):
        for k in ("key", "id"):
            v = item.get(k)
            if v is not None:
                return str(v)
        return None
    for attr in ("key", "id"):
        v = getattr(item, attr, None)
        if v is not None:
            return str(v)
    return None


def _extract_store_value(item: Any) -> Any:
    if isinstance(item, tuple) and len(item) >= 2:
        return item[1]
    if isinstance(item, dict):
        if "value" in item:
            return item.get("value")
        return item
    return getattr(item, "value", item)


def _unpack_store_value(out: Any, default: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """将 store.get 返回值解包为 dict，避免重复 v = getattr(out, 'value', out); val = dict(v) if ..."""
    v = getattr(out, "value", out) if not isinstance(out, dict) else out
    if isinstance(v, dict):
        return dict(v)
    return default if default is not None else {}


async def _store_list_keys(store: Any, namespace: tuple, limit: int = 500) -> List[str]:
    def _inner() -> List[str]:
        if hasattr(store, "list"):
            return [str(k) for k in list(store.list(namespace))[:limit]]
        if hasattr(store, "search"):
            items = store.search(namespace, limit=limit)
            keys: List[str] = []
            for item in items:
                key = _extract_store_key(item)
                if key:
                    keys.append(key)
            return keys
        return []

    return await asyncio.to_thread(_inner)


async def _store_list_items(store: Any, namespace: tuple, limit: int = 500) -> List[Dict[str, Any]]:
    """
    优先通过 store.search 一次性批量返回 (key, value) 对，避免 list+N 次 get 的 N+1 开销。
    回退路径保持与原行为一致。
    """

    def _inner() -> List[Dict[str, Any]]:
        # Fast path: storage supports search(namespace, limit)
        if hasattr(store, "search"):
            items = store.search(namespace, limit=limit)
            rows: List[Dict[str, Any]] = []
            for item in items:
                key = _extract_store_key(item)
                value = _extract_store_value(item)
                if key is None or not isinstance(value, dict):
                    continue
                rows.append({"id": str(key), **dict(value)})
            if rows:
                return rows

        # Fallback: keep previous semantics (list keys then get each)
        rows = []
        keys = [str(k) for k in list(store.list(namespace))[:limit]] if hasattr(store, "list") else []
        for key in keys:
            out = store.get(namespace, key)
            if not out:
                continue
            value = _extract_store_value(out)
            if not isinstance(value, dict):
                continue
            rows.append({"id": str(key), **dict(value)})
        return rows

    return await asyncio.to_thread(_inner)


async def _store_get(store: Any, namespace: tuple, key: str):
    return await asyncio.to_thread(store.get, namespace, key)


async def _store_put(store: Any, namespace: tuple, key: str, value: Any) -> None:
    last_err: Optional[Exception] = None
    for attempt in range(3):
        try:
            await asyncio.to_thread(store.put, namespace, key, value)
            return
        except Exception as e:
            last_err = e
            if attempt < 2:
                await asyncio.sleep(0.05 * (attempt + 1))
    raise RuntimeError(f"store.put failed: ns={namespace} key={key} err={last_err}")


def _ensure_execution_state(task: Dict[str, Any]) -> Dict[str, Any]:
    execution = task.get("execution")
    if not isinstance(execution, dict):
        execution = {}
    execution.setdefault("active_run_id", None)
    execution.setdefault("last_success_step_seq", 0)
    execution.setdefault("completed_step_ids", [])
    execution.setdefault("inflight_step_ids", [])
    execution.setdefault("idempotency_key", "")
    execution.setdefault("execution_fingerprint", "")
    execution.setdefault("lease_owner", None)
    execution.setdefault("lease_expires_at", None)
    execution.setdefault("last_event_seq", 0)
    execution.setdefault("recovery_point", None)
    execution.setdefault("state_version", 1)
    execution.setdefault("recovery_available", False)
    execution.setdefault("recovery_reason", "")
    task["execution"] = execution
    return execution


_dispatch_tasks: set = set()


def _fire_and_forget_dispatch(task_id: str, scope: str, reason: str) -> None:
    async def _runner() -> None:
        try:
            from backend.engine.tasks.task_watcher import dispatch_task_once

            result = await dispatch_task_once(task_id=task_id, scope=scope)
            logger.info(
                "即时分发触发完成: task_id=%s scope=%s reason=%s result=%s",
                task_id,
                scope,
                reason,
                result.get("state") if isinstance(result, dict) else "unknown",
            )
        except Exception as e:
            logger.debug("即时分发触发失败（非关键） task_id=%s reason=%s: %s", task_id, reason, e)

    def _done(t: asyncio.Task) -> None:
        _dispatch_tasks.discard(t)
        try:
            t.result()
        except Exception as e:
            logger.warning("即时分发 Task 异常 task_id=%s reason=%s: %s", task_id, reason, e)

    try:
        task = asyncio.ensure_future(_runner())
        _dispatch_tasks.add(task)
        task.add_done_callback(_done)
    except RuntimeError:
        logger.debug("无运行事件循环，跳过即时分发 task_id=%s", task_id)


def _is_valid_board_transition(current_status: str, next_status: str) -> bool:
    """
    看板层状态迁移校验：复用 watcher 规则，并兼容 UI 的“重置为 available”语义。
    """
    current = str(current_status or "").strip().lower()
    target = str(next_status or "").strip().lower()
    if not target:
        return True
    if current == target:
        return True
    try:
        from backend.engine.tasks.task_watcher import _is_valid_transition
    except Exception:
        logger.warning("状态迁移校验函数加载失败，默认拒绝迁移")
        return False
    if _is_valid_transition(current, target):
        return True
    # 兼容前端“重新开始”动作：允许从终态/暂停态回到 available
    if target == "available" and current in {
        "failed",
        "cancelled",
        "paused",
        "waiting_human",
        "blocked",
        "awaiting_plan_confirm",
    }:
        return True
    return False


def _safe_parse_datetime(raw: str) -> Optional[datetime]:
    s = str(raw or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except Exception:
        return None


# A2A 跨实例：接收任务邀请（远程节点 POST 到此端点，本节点可展示邀请并向 callback_url 提交竞标）
class BoardTaskInviteBody(BaseModel):
    task_id: str
    subject: Optional[str] = ""
    description: Optional[str] = ""
    required_skills: Optional[List[str]] = None
    callback_url: Optional[str] = None


@router.post("/board/task-invite")
async def board_task_invite(request: Request, body: BoardTaskInviteBody, _: None = Depends(verify_internal_token)):
    """
    接收来自其他实例的任务邀请（A2A 网关）。
    发布者通过 broadcast_task_to_network 将任务推送到各节点；各节点 POST 到此端点。
    本节点可据此展示「待竞标任务」或触发自评估后向 body.callback_url 提交竞标。
    """
    _verify_a2a_secret(request)
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        from uuid import uuid4

        task_id = (body.task_id or "").strip()
        if not task_id:
            raise HTTPException(status_code=400, detail="task_id 必填")
        callback_url = (body.callback_url or "").strip() or None
        if callback_url and not _is_safe_callback_url(callback_url):
            raise HTTPException(status_code=400, detail="callback_url 不在允许的白名单内或格式不安全")
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        invite_id = f"invite-{uuid4()}"
        invite = {
            "invite_id": invite_id,
            "task_id": task_id,
            "subject": body.subject or "",
            "description": body.description or "",
            "required_skills": body.required_skills or [],
            "callback_url": callback_url,
            "received_at": datetime.now(timezone.utc).isoformat(),
            "status": "received",
        }
        await _store_put(store, NS_BOARD_INVITES, invite_id, invite)
        logger.info("A2A 收到任务邀请: task_id=%s, callback=%s", task_id, invite.get("callback_url"))
        return {"ok": True, "invite": invite, "message": "邀请已接收，可向 callback_url 提交竞标"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("处理任务邀请失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.get("/board/invites")
async def board_list_invites(request: Request, limit: int = 100, _: None = Depends(verify_internal_token)):
    """查询已接收的 A2A 邀请。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        cap = min(max(0, limit), 500)
        rows = await _store_list_items(store, NS_BOARD_INVITES, limit=cap)
        invites = [{"id": row.get("id", ""), **row} for row in rows]
        invites.sort(key=lambda x: str(x.get("received_at") or ""), reverse=True)
        return {"ok": True, "invites": invites}
    except Exception as e:
        logger.exception("获取邀请列表失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class InviteBidBody(BaseModel):
    agent_id: str
    confidence: Optional[float] = 0.6
    reason: Optional[str] = ""
    estimated_effort: Optional[str] = "medium"


@router.post("/board/invites/{invite_id}/bid")
async def board_bid_invite(invite_id: str, body: InviteBidBody, _: None = Depends(verify_internal_token)):
    """对 A2A 邀请一键回调竞标。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store

        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        out = await _store_get(store, NS_BOARD_INVITES, invite_id)
        if not out:
            raise HTTPException(status_code=404, detail="邀请不存在")
        v = getattr(out, "value", out) if not isinstance(out, dict) else out
        invite = dict(v) if isinstance(v, dict) else {}
        callback_url = str(invite.get("callback_url") or "").strip()
        if not callback_url:
            raise HTTPException(status_code=400, detail="该邀请没有 callback_url")
        if not _is_safe_callback_url(callback_url):
            raise HTTPException(status_code=400, detail="callback_url 仅允许 https 且在 SAFE_CALLBACK_HOSTS 白名单内")
        payload = {
            "agent_id": body.agent_id,
            "confidence": float(body.confidence or 0.6),
            "reason": body.reason or "A2A invite bid",
            "estimated_effort": body.estimated_effort or "medium",
        }
        task_id = str(invite.get("task_id") or "").strip()
        if not task_id:
            raise HTTPException(status_code=400, detail="邀请缺少 task_id")
        endpoint = f"{callback_url.rstrip('/')}/board/tasks/{_url_quote(task_id, safe='')}/bids"
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=15.0, write=10.0, pool=5.0)
        ) as client:
            resp = await client.post(endpoint, json=payload)
        invite["status"] = "bid_submitted" if resp.status_code < 400 else "bid_failed"
        invite["last_bid_at"] = datetime.now(timezone.utc).isoformat()
        invite["last_bid_status_code"] = resp.status_code
        await _store_put(store, NS_BOARD_INVITES, invite_id, invite)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=f"回调失败: HTTP {resp.status_code}")
        return {"ok": True, "invite_id": invite_id, "task_id": task_id, "callback_status": resp.status_code}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("邀请竞标回调失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


def _parse_cursor(cursor: Optional[str]) -> tuple:
    """解析游标为 (created_at, task_id)，无效则返回 (None, None)。"""
    if not cursor or not isinstance(cursor, str):
        return (None, None)
    parts = cursor.strip().split("|", 1)
    if len(parts) != 2:
        return (None, None)
    return (parts[0].strip() or None, parts[1].strip() or None)


def _make_cursor(created_at: str, task_id: str) -> str:
    """生成游标字符串。"""
    return f"{created_at or ''}|{task_id or ''}"


@router.get("/board/tasks")
async def board_list_tasks(
    scope: str = "personal",
    status: Optional[str] = None,
    role_id: Optional[str] = None,
    limit: int = 100,
    cursor: Optional[str] = Query(None, description="游标分页：上一页返回的 next_cursor"),
    workspace_path: Optional[str] = Query(None, description="按工作区过滤，仅返回该工作区或未设置工作区的任务"),
):
    """列出看板任务。游标分页：cursor 为 created_at|task_id，返回 next_cursor 供下一页。"""
    if scope not in VALID_BOARD_SCOPES:
        raise HTTPException(status_code=403, detail="invalid scope")
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ns = _board_ns_for_scope(scope)
        cap = max(1, min(int(limit if limit is not None else 100), 500))
        try:
            now_ts = time.monotonic()
            cached = _board_list_cache.get(scope)
            if cached is not None and (now_ts - cached[0]) < _BOARD_LIST_CACHE_TTL_SEC:
                rows = cached[1]
            else:
                rows = await _store_list_items(store, ns, limit=500)
                _board_list_cache[scope] = (now_ts, rows)
                if len(_board_list_cache) > _board_list_cache_max_entries:
                    oldest = min(_board_list_cache.items(), key=lambda x: x[1][0])
                    _board_list_cache.pop(oldest[0], None)
            allowed = None
            if status is not None:
                allowed = {status}
                if status == "pending":
                    allowed = {"pending", "available"}
            normalized_role_id = str(role_id or "").strip()
            wp = str(workspace_path or "").strip() or None
            filtered = []
            for row in rows:
                task_role_id = str(row.get("role_id") or "").strip()
                if normalized_role_id and task_role_id != normalized_role_id:
                    continue
                if wp:
                    row_wp = str(row.get("workspace_path") or "").strip()
                    if row_wp and row_wp != wp:
                        continue
                if allowed is None or row.get("status") in allowed:
                    filtered.append(row)
            filtered.sort(key=lambda r: (r.get("created_at") or "", r.get("task_id") or r.get("id") or ""), reverse=True)
            cursor_created, cursor_task = _parse_cursor(cursor)
            if cursor_created is not None and cursor_task is not None:
                start = len(filtered)
                for i, r in enumerate(filtered):
                    ca, tid = r.get("created_at") or "", (r.get("task_id") or r.get("id")) or ""
                    if (ca, tid) < (cursor_created, cursor_task):
                        start = i
                        break
                filtered = filtered[start:]
            tasks = filtered[:cap]
            next_cursor = None
            if len(filtered) > cap:
                last = tasks[-1]
                next_cursor = _make_cursor(last.get("created_at") or "", last.get("task_id") or last.get("id") or "")
            return {"ok": True, "tasks": tasks, "next_cursor": next_cursor}
        except Exception as e:
            logger.warning("board list: %s", e)
            raise HTTPException(status_code=500, detail=_safe_error_detail(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("看板列表失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.get("/board/tasks/{task_id}")
async def board_get_task(task_id: str = Depends(_validate_task_id), scope: Optional[str] = None):
    """按 id 直查单条看板任务。scope 可选：personal|org|public；不传则依次尝试 personal → org → public。"""
    if scope is not None and scope not in VALID_BOARD_SCOPES:
        raise HTTPException(status_code=403, detail="invalid scope")
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        scopes = [scope] if scope and scope in VALID_BOARD_SCOPES else ["personal", "org", "public"]
        for s in scopes:
            ns = _board_ns_for_scope(s)
            out = await _store_get(store, ns, task_id)
            if not out:
                continue
            v = getattr(out, "value", out) if not isinstance(out, dict) else out
            val = dict(v) if isinstance(v, dict) else {}
            if not val:
                continue
            val["id"] = val.get("id") or task_id
            val["task_id"] = val.get("task_id") or task_id
            return {"ok": True, "task": val}
        raise HTTPException(status_code=404, detail="任务不存在")
    except Exception as e:
        logger.exception("看板单任务查询失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.get("/board/metrics/reliability")
async def board_reliability_metrics(scope: str = "personal", window_hours: int = 72):
    """单体阶段可靠性指标快照（任务成功率、blocked 恢复率、人类干预率等）。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store

        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ns = _board_ns_for_scope(scope)
        tasks: List[Dict[str, Any]] = await _store_list_items(store, ns, limit=500)

        now = datetime.now(timezone.utc)
        window = timedelta(hours=max(1, min(int(window_hours), 8760)))
        # 默认排除测试/脚本来源，避免发布演练样本污染正式可靠性口径。
        excluded_source_channels = {"test", "script", "ci"}
        in_window: List[Dict[str, Any]] = []
        excluded_by_source = 0
        for t in tasks:
            source_channel = str(t.get("source_channel") or "").strip().lower()
            if source_channel in excluded_source_channels:
                excluded_by_source += 1
                continue
            ts_raw = str(t.get("updated_at") or t.get("created_at") or "").strip()
            ts = _safe_parse_datetime(ts_raw)
            if ts is not None and now - ts <= window:
                in_window.append(t)

        terminal = [t for t in in_window if str(t.get("status") or "").lower() in {"completed", "failed", "cancelled"}]
        completed = [t for t in terminal if str(t.get("status") or "").lower() == "completed"]
        failed = [t for t in terminal if str(t.get("status") or "").lower() == "failed"]
        cancelled = [t for t in terminal if str(t.get("status") or "").lower() == "cancelled"]
        # blocked 恢复口径：先识别“曾阻塞任务”，再统计其中恢复到 running/completed 的数量。
        # 不能只用当前 status=blocked 作为分母，否则 blocked_reason 保留时会出现恢复率>1。
        recoverable_states = {"available", "claimed", "running", "waiting_human", "completed"}
        blocked_candidates = [
            t
            for t in in_window
            if str(t.get("status") or "").lower() == "blocked"
            or str(t.get("blocked_at") or "").strip()
            or str(t.get("recovered_at") or "").strip()
            or str(t.get("blocked_reason") or "").strip()
        ]
        blocked_total = len(blocked_candidates)
        blocked_recovered = sum(
            1
            for t in blocked_candidates
            if str(t.get("recovered_at") or "").strip()
            or (
                str(t.get("blocked_reason") or "").strip()
                and str(t.get("status") or "").lower() in recoverable_states
            )
        )
        human_intervened = sum(1 for t in in_window if isinstance(t.get("human_reviews"), list) and len(t.get("human_reviews") or []) > 0)
        def _has_effective_deliverable(task: Dict[str, Any]) -> bool:
            deliverables = task.get("deliverables")
            if isinstance(deliverables, list) and len(deliverables) > 0:
                return True
            changed_files = task.get("changed_files")
            if isinstance(changed_files, list) and len(changed_files) > 0:
                return True
            if str(task.get("rollback_hint") or "").strip():
                return True
            return False

        deliverable_ready = sum(1 for t in completed if _has_effective_deliverable(t))

        # success_rate 按“执行终态”定义，不把用户主动取消视为执行失败。
        execution_terminal_count = len(completed) + len(failed)
        success_rate = (len(completed) / execution_terminal_count) if execution_terminal_count else 0.0
        blocked_recovery_rate = (blocked_recovered / blocked_total) if blocked_total else 0.0
        human_intervention_rate = (human_intervened / len(in_window)) if in_window else 0.0
        deliverable_effective_rate = (deliverable_ready / len(completed)) if completed else 0.0

        async with _board_patch_lock:
            patch_attempts = _board_patch_status_attempts
            patch_conflicts = _board_patch_status_conflicts
        status_projection_conflict_rate = (patch_conflicts / patch_attempts) if patch_attempts else 0.0
        return {
            "ok": True,
            "metrics": {
                "scope": scope,
                "window_hours": int(window_hours),
                "task_count": len(in_window),
                "excluded_task_count_by_source": excluded_by_source,
                "excluded_source_channels": sorted(excluded_source_channels),
                "terminal_count": len(terminal),
                "completed_count": len(completed),
                "failed_count": len(failed),
                "cancelled_count": len(cancelled),
                "success_rate": round(success_rate, 4),
                "blocked_total": blocked_total,
                "blocked_recovered": blocked_recovered,
                "blocked_recovery_rate": round(blocked_recovery_rate, 4),
                "human_intervened_count": human_intervened,
                "human_intervention_rate": round(human_intervention_rate, 4),
                "deliverable_ready_count": deliverable_ready,
                "deliverable_effective_rate": round(deliverable_effective_rate, 4),
                "status_projection_attempts": patch_attempts,
                "status_projection_conflicts": patch_conflicts,
                "status_projection_conflict_rate": round(status_projection_conflict_rate, 4),
            },
        }
    except Exception as e:
        logger.exception("可靠性指标统计失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.get("/board/ops/latest-release-gate-summary")
async def board_latest_release_gate_summary():
    """返回最近一次 release gate 汇总（只读透传 backend/data/release_gate_summary.json）。"""
    try:
        root = get_api_project_root()
        summary_path = root / "backend" / "data" / "release_gate_summary.json"
        if not summary_path.exists():
            raise HTTPException(status_code=404, detail="release_gate_summary.json 不存在")
        text = await asyncio.to_thread(summary_path.read_text, encoding="utf-8")
        payload = json.loads(text)
        return {"ok": True, "summary": payload}
    except Exception as e:
        logger.exception("读取 release gate summary 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class BoardTaskCreate(BaseModel):
    subject: str = Field(..., max_length=2000)
    description: Optional[str] = Field("", max_length=10000)
    priority: Optional[int] = 3
    scope: Optional[str] = "personal"
    workspace_path: Optional[str] = None
    source_channel: Optional[str] = "local"
    cost_tier: Optional[str] = "medium"
    splittable: Optional[bool] = False
    total_units: Optional[int] = None
    unit_label: Optional[str] = None
    required_skills: Optional[List[str]] = Field(default=None, max_length=50)
    human_checkpoints: Optional[List[dict]] = Field(default=None, max_length=20)
    require_plan_confirmation: Optional[bool] = False
    skill_profile: Optional[str] = None
    role_id: Optional[str] = None


@router.post("/board/tasks")
async def board_create_task(request: Request, body: BoardTaskCreate, _: None = Depends(verify_internal_token)):
    """在看板创建任务（默认个人看板）。支持 X-Idempotency-Key 幂等创建。"""
    try:
        import uuid
        from datetime import datetime, timezone
        from backend.engine.core.main_graph import get_sqlite_store
        scope = body.scope or "personal"
        idempotency_key = (request.headers.get("X-Idempotency-Key") or "").strip()
        cache_key = (scope, idempotency_key) if idempotency_key else None
        async with _idempotency_create_lock:
            if cache_key is not None and cache_key in _idempotency_create_cache:
                entry = _idempotency_create_cache[cache_key]
                task_id = entry[0] if isinstance(entry, tuple) and len(entry) >= 2 else entry
                ts = entry[1] if isinstance(entry, tuple) and len(entry) >= 2 else 0.0
                if time.monotonic() - ts <= _IDEMPOTENCY_CACHE_TTL_SEC:
                    store = get_sqlite_store()
                    if store is not None:
                        ns = _board_ns_for_scope(scope)
                        out = await asyncio.to_thread(store.get, ns, task_id)
                        if out is not None:
                            val = getattr(out, "value", out) if not isinstance(out, dict) else out
                            if isinstance(val, dict):
                                dispatch_state = (
                                    "awaiting_plan_confirm"
                                    if (val.get("status") or "").lower() == "awaiting_plan_confirm"
                                    else ("waiting_human" if (val.get("status") or "").lower() == "waiting_human" else "dispatching")
                                )
                                return {"ok": True, "task_id": task_id, "task": {"id": task_id, **val}, "dispatch_state": dispatch_state}
                else:
                    _idempotency_create_cache.pop(cache_key, None)
                    try:
                        _idempotency_cache_keys.remove(cache_key)
                    except ValueError:
                        pass
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ns = _board_ns_for_scope(scope)

        def _do_create() -> tuple:
            tid = str(uuid.uuid4())
            now_iso = datetime.now(timezone.utc).isoformat()
            checkpoints = _normalize_human_checkpoints(body.human_checkpoints or [])
            has_pending_checkpoints = any(str(cp.get("status") or "").lower() == "pending" for cp in checkpoints)
            require_plan_confirmation = bool(body.require_plan_confirmation)
            if require_plan_confirmation:
                initial_status = "awaiting_plan_confirm"
                initial_progress = "等待确认执行计划"
            else:
                initial_status = "waiting_human" if has_pending_checkpoints else "available"
                initial_progress = "等待人工确认检查点" if has_pending_checkpoints else None
            v = {
                "task_id": tid,
                "request_id": str(uuid.uuid4()),
                "request_enqueued_at": int(datetime.now(timezone.utc).timestamp() * 1000),
                "session_id": tid,
                "subject": body.subject,
                "description": (body.description or "").strip(),
                "status": initial_status,
                "priority": max(1, min(5, body.priority or 3)),
                "scope": body.scope or "personal",
                "workspace_path": (body.workspace_path or "").strip() or None,
                "source_channel": body.source_channel or "local",
                "cost_tier": body.cost_tier or "medium",
                "created_at": now_iso,
                "updated_at": now_iso,
                "splittable": body.splittable or False,
                "total_units": body.total_units,
                "claimed_units": 0,
                "unit_label": body.unit_label,
                "parent_task_id": None,
                "subtask_ids": [],
                "required_skills": body.required_skills or [],
                "human_checkpoints": checkpoints,
                "skill_profile": body.skill_profile or "full",
                "role_id": str(body.role_id or "").strip() or None,
                "license_tier": get_api_current_tier(),
                "queue_timeout_seconds": int(os.environ.get("TASK_CLAIMED_TIMEOUT_SECONDS", "180")),
                "execution_timeout_seconds": int(os.environ.get("TASK_RUNNING_TIMEOUT_SECONDS", "1800")),
                "progress": 0,
                "progress_message": initial_progress,
                "external_task_id": None,
                "pricing": None,
                "changed_files": [],
                "rollback_hint": "",
                "blocked_reason": None,
                "missing_information": [],
                "blocked_at": None,
                "recovered_at": None,
                "bids": [],
                "claimed_by": None,
                "auto_assign": False,
                "bid_deadline": None,
                "relay_id": None,
                "origin_role": None,
                "target_role": None,
                "relay_status": None,
                "relay_type": None,
                "relay_context": None,
                "decision_points": [],
                "human_reviews": [],
                "execution": {
                    "active_run_id": None,
                    "last_success_step_seq": 0,
                    "completed_step_ids": [],
                    "inflight_step_ids": [],
                    "idempotency_key": "",
                    "execution_fingerprint": "",
                    "lease_owner": None,
                    "lease_expires_at": None,
                    "last_event_seq": 0,
                    "recovery_point": None,
                    "state_version": 1,
                    "recovery_available": False,
                    "recovery_reason": "",
                },
            }
            return (tid, v, initial_status)

        if cache_key is not None:
            async with _idempotency_create_lock:
                if cache_key in _idempotency_create_cache:
                    entry = _idempotency_create_cache[cache_key]
                    task_id = entry[0] if isinstance(entry, tuple) and len(entry) >= 2 else entry
                    out = await asyncio.to_thread(store.get, ns, task_id)
                    if out is not None:
                        val = getattr(out, "value", out) if not isinstance(out, dict) else out
                        if isinstance(val, dict):
                            dispatch_state = (
                                "awaiting_plan_confirm"
                                if (val.get("status") or "").lower() == "awaiting_plan_confirm"
                                else ("waiting_human" if (val.get("status") or "").lower() == "waiting_human" else "dispatching")
                            )
                            return {"ok": True, "task_id": task_id, "task": {"id": task_id, **val}, "dispatch_state": dispatch_state}
                task_id, val, initial_status = _do_create()
                await asyncio.to_thread(store.put, ns, task_id, val)
                while len(_idempotency_cache_keys) >= _IDEMPOTENCY_CACHE_MAX and _idempotency_cache_keys:
                    old = _idempotency_cache_keys.popleft()
                    _idempotency_create_cache.pop(old, None)
                _idempotency_create_cache[cache_key] = (task_id, time.monotonic())
                _idempotency_cache_keys.append(cache_key)
        else:
            task_id, val, initial_status = _do_create()
            await asyncio.to_thread(store.put, ns, task_id, val)

        if os.getenv("BOARD_BROADCAST_INVITE", "false").lower() == "true":
            try:
                from backend.engine.network.registry import broadcast_task_to_network, list_nodes
                if list_nodes():
                    base_url = os.environ.get("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")
                    await broadcast_task_to_network(
                        {"task_id": task_id, "subject": val["subject"], "description": val["description"], "required_skills": val.get("required_skills") or []},
                        local_bid_callback_url=base_url,
                    )
            except Exception as br:
                logger.debug("看板任务广播邀请失败（非关键）: %s", br)
        dispatch_state = (
            "awaiting_plan_confirm"
            if initial_status == "awaiting_plan_confirm"
            else ("waiting_human" if initial_status == "waiting_human" else "dispatching")
        )
        auto_dispatch_on_create = str(os.getenv("BOARD_CREATE_TASK_AUTO_DISPATCH", "true")).strip().lower() in {"1", "true", "yes", "on"}
        source_channel = str(body.source_channel or "local").strip().lower()
        should_dispatch_on_create = initial_status == "available" and auto_dispatch_on_create and source_channel not in {"test", "script", "ci"}
        if should_dispatch_on_create:
            _fire_and_forget_dispatch(task_id=task_id, scope=body.scope or "personal", reason="create_task")
        _board_list_cache.pop(scope, None)
        return {"ok": True, "task_id": task_id, "task": {"id": task_id, **val}, "dispatch_state": dispatch_state}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("看板创建任务失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


_BOARD_UPDATE_TASK_BODY_KEYS = frozenset({
    "scope", "status", "result", "thread_id", "description", "deliverables", "changed_files",
    "rollback_hint", "blocked_reason", "missing_information", "progress", "progress_message",
    "claimed_by", "bids", "auto_assign", "bid_deadline", "relay_id", "origin_role",
    "target_role", "relay_status", "relay_type", "relay_context", "execution",
})

# execution 子对象仅允许业务字段由外部 patch，禁止 lease_owner/active_run_id/state_version 等敏感字段
_EXECUTION_PATCH_ALLOWED_KEYS = frozenset({
    "progress", "recovery_point", "recovery_available", "recovery_reason", "updated_at",
})


@router.patch("/board/tasks/{task_id}")
async def board_update_task(task_id: str = Depends(_validate_task_id), body: dict = Body(default={}), _: None = Depends(verify_internal_token)):
    """更新看板任务（状态、结果、thread_id 等）。"""
    global _board_patch_status_attempts, _board_patch_status_conflicts
    unknown = [k for k in body if k not in _BOARD_UPDATE_TASK_BODY_KEYS]
    if unknown:
        raise HTTPException(status_code=422, detail=f"不允许的字段: {unknown}")
    try:
        from datetime import datetime, timezone
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        scope = body.get("scope", "personal")
        ns = _board_ns_for_scope(scope)
        out = await _store_get(store, ns, task_id)
        if not out:
            raise HTTPException(status_code=404, detail="任务不存在")
        v = getattr(out, "value", out) if not isinstance(out, dict) else out
        val = dict(v) if isinstance(v, dict) else {"subject": "", "status": "available", "priority": 3}
        execution = _ensure_execution_state(val)
        base_state_version = int(execution.get("state_version", 0) or 0)
        prev_status = str(val.get("status") or "")
        if "status" in body:
            next_status = str(body.get("status") or "").strip().lower()
            if next_status and not _is_valid_board_transition(prev_status, next_status):
                raise HTTPException(
                    status_code=400,
                    detail=f"非法状态迁移: {prev_status or 'unknown'} -> {next_status}",
                )
            if next_status:
                val["status"] = next_status
        if "result" in body:
            val["result"] = body["result"]
        if "thread_id" in body:
            val["thread_id"] = body["thread_id"]
        if "description" in body:
            val["description"] = str(body.get("description") or "").strip()
        if "deliverables" in body:
            val["deliverables"] = body["deliverables"]
        if "changed_files" in body:
            val["changed_files"] = body["changed_files"]
        if "rollback_hint" in body:
            val["rollback_hint"] = body["rollback_hint"]
        if "blocked_reason" in body:
            val["blocked_reason"] = body["blocked_reason"]
        if "missing_information" in body:
            val["missing_information"] = body["missing_information"]
        if "progress" in body:
            try:
                val["progress"] = max(0, min(100, int(body["progress"])))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="progress 必须是整数")
        if "progress_message" in body:
            val["progress_message"] = body["progress_message"]
        if "claimed_by" in body:
            val["claimed_by"] = body["claimed_by"]
        if "bids" in body:
            raw_bids = body["bids"] if isinstance(body["bids"], list) else []
            val["bids"] = [b for b in raw_bids if isinstance(b, dict)][:50]
        if "auto_assign" in body:
            val["auto_assign"] = bool(body["auto_assign"])
        if "bid_deadline" in body:
            val["bid_deadline"] = body["bid_deadline"]
        if "relay_id" in body:
            val["relay_id"] = body["relay_id"]
        if "origin_role" in body:
            val["origin_role"] = body["origin_role"]
        if "target_role" in body:
            val["target_role"] = body["target_role"]
        if "relay_status" in body:
            val["relay_status"] = body["relay_status"]
        if "relay_type" in body:
            val["relay_type"] = body["relay_type"]
        if "relay_context" in body:
            val["relay_context"] = body["relay_context"]
        if "execution" in body and isinstance(body.get("execution"), dict):
            patch_execution = body.get("execution") or {}
            if isinstance(patch_execution, dict):
                for k, v in patch_execution.items():
                    if k in _EXECUTION_PATCH_ALLOWED_KEYS:
                        execution[k] = v
                val["execution"] = execution

        # 任务完成后自动沉淀：record_pattern + 技能提示 + 实体/关系快照（文件 IO 放线程池避免阻塞事件循环）
        def _jsonl_append(path: Path, row: dict) -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            with _board_jsonl_append_lock:
                with path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")

        async def _record_learning_error(stage: str, err: Exception) -> None:
            try:
                data_dir = get_api_project_root() / "data"
                row = {
                    "task_id": task_id,
                    "stage": stage,
                    "error": str(err),
                    "status": str(val.get("status") or ""),
                    "subject": str(val.get("subject") or "")[:200],
                    "recorded_at": datetime.now(timezone.utc).isoformat(),
                }
                await asyncio.to_thread(_jsonl_append, data_dir / "learning_errors.jsonl", row)
            except Exception:
                logger.debug("学习错误写入失败（非关键）")

        now_iso = datetime.now(timezone.utc).isoformat()
        execution["state_version"] = int(execution.get("state_version", 0) or 0) + 1
        execution["updated_at"] = now_iso
        now_status = str(val.get("status") or "")
        prev_status_norm = str(prev_status or "").strip().lower()
        now_status_norm = str(now_status or "").strip().lower()
        if now_status_norm == "blocked" and prev_status_norm != "blocked":
            val["blocked_at"] = now_iso
            val["recovered_at"] = None
            execution["recovery_available"] = True
            execution["recovery_reason"] = "blocked"
        if prev_status_norm == "blocked" and now_status_norm != "blocked":
            val["recovered_at"] = now_iso
            execution["recovery_reason"] = ""
            # 仅当 body 显式传入 blocked_reason: null / missing_information: [] 时才清空，否则保留诊断信息便于追溯
            if "blocked_reason" in body and body["blocked_reason"] is None:
                val["blocked_reason"] = None
            if "missing_information" in body and body["missing_information"] is not None:
                val["missing_information"] = body["missing_information"] if isinstance(body["missing_information"], list) else []
        if now_status_norm in {"failed", "cancelled", "paused"}:
            execution["recovery_available"] = True
            execution["recovery_reason"] = now_status_norm
        elif now_status_norm in {"running", "in_progress", "completed"}:
            execution["recovery_available"] = False
            if now_status_norm == "completed":
                execution["recovery_reason"] = ""
        if now_status_norm == "completed" and prev_status_norm != "completed":
            result_text = str(val.get("result") or "").strip()
            if not isinstance(val.get("deliverables"), list):
                val["deliverables"] = []
            if not isinstance(val.get("changed_files"), list):
                val["changed_files"] = []
            if not val["deliverables"]:
                fallback_summary = " ".join(result_text.split())[:120] if result_text else str(val.get("subject") or "任务已完成")
                val["deliverables"] = [f"任务交付摘要：{fallback_summary}"]
            if not str(val.get("rollback_hint") or "").strip():
                val["rollback_hint"] = "如需回滚，请恢复最近一次变更并重新执行该任务。"
            required_skills = val.get("required_skills") if isinstance(val.get("required_skills"), list) else []
            required_skills = [str(s).strip() for s in required_skills if str(s).strip()]
            hints = list(dict.fromkeys(required_skills))[:5]
            if not hints:
                subject_text = str(val.get("subject") or "")
                if any(k in subject_text for k in ["本体", "知识", "ontology", "knowledge"]):
                    hints.append("knowledge-building")
                if any(k in subject_text for k in ["方案", "投标", "bidding"]):
                    hints.append("bidding")
            val["skill_hints"] = hints

            pattern_row = {
                "task_id": task_id,
                "subject": val.get("subject"),
                "skill_profile": val.get("skill_profile"),
                "required_skills": required_skills,
                "skill_hints": hints,
                "result_excerpt": result_text[:600],
                "deliverables": val.get("deliverables") if isinstance(val.get("deliverables"), list) else [],
                "thread_id": val.get("thread_id"),
                "recorded_at": now_iso,
            }
            entity_row = {
                "task_id": task_id,
                "entities": [
                    {"name": str(val.get("subject") or ""), "type": "task_subject"},
                    *[
                        {"name": str(s), "type": "skill"}
                        for s in required_skills[:8]
                    ],
                ],
                "relations": [
                    {"source": str(val.get("subject") or ""), "target": str(s), "type": "uses_skill"}
                    for s in required_skills[:8]
                ],
                "recorded_at": now_iso,
            }
            try:
                data_dir = get_api_project_root() / "data"
                await asyncio.to_thread(_jsonl_append, data_dir / "task_success_patterns.jsonl", pattern_row)
                await asyncio.to_thread(_jsonl_append, data_dir / "task_entities_relations.jsonl", entity_row)
            except Exception as e:
                logger.warning("任务沉淀写入失败（非关键）: %s", e)

            # 复用 Learning 子系统（LangChain/LangGraph 路径），避免重复造轮子
            try:
                from backend.tools.base.learning_middleware import learn_from_success, learn_from_document

                await asyncio.to_thread(
                    learn_from_success,
                    task_id=task_id,
                    task_type=str(val.get("skill_profile") or "general"),
                    input_summary=str(val.get("subject") or "")[:400],
                    output_summary=result_text[:1200],
                    entities_used=required_skills[:12],
                    workspace_domain=str(val.get("skill_profile") or "general"),
                )
                synthetic_doc = (
                    f"任务主题: {str(val.get('subject') or '')}\n"
                    f"任务描述: {str(val.get('description') or '')}\n"
                    f"执行结果: {result_text[:1600]}\n"
                    f"技能提示: {', '.join(hints)}\n"
                )
                await asyncio.to_thread(learn_from_document, task_id=task_id, document_text=synthetic_doc, document_source=f"board_task::{task_id}")
            except Exception as e:
                logger.debug("学习系统沉淀失败（非关键）: %s", e)
                await _record_learning_error("learn_from_success_or_document", e)
            # 持久化 completed 并写入投影字段（单一真源开启时）
            from backend.engine.tasks.task_bidding import project_board_task_status as _project, is_task_single_source_enabled
            if is_task_single_source_enabled():
                proj_extra = {k: val.get(k) for k in ("deliverables", "changed_files", "rollback_hint", "description", "skill_hints") if k in val}
                _proj = await asyncio.to_thread(
                    _project, task_id, "completed", scope,
                    thread_id=val.get("thread_id"), result=val.get("result"), progress=val.get("progress"),
                    progress_message=val.get("progress_message"), source="board_api_patch", extra_updates=proj_extra or None,
                )
                if _proj:
                    latest = await _store_get(store, ns, task_id)
                    latest_raw = getattr(latest, "value", latest) if not isinstance(latest, dict) else latest
                    val = dict(latest_raw) if isinstance(latest_raw, dict) else val
            else:
                val["updated_at"] = now_iso
                await _store_put(store, ns, task_id, val)
        elif now_status == "failed" and prev_status != "failed":
            try:
                from backend.tools.base.learning_middleware import learn_from_failure

                await asyncio.to_thread(
                    learn_from_failure,
                    task_id=task_id,
                    task_type=str(val.get("skill_profile") or "general"),
                    error_message=str(val.get("result") or "task failed")[:1000],
                    input_summary=str(val.get("subject") or "")[:400],
                    workspace_domain=str(val.get("skill_profile") or "general"),
                )
            except Exception as e:
                logger.debug("失败学习沉淀失败（非关键）: %s", e)
                await _record_learning_error("learn_from_failure", e)
            if "status" in body:
                from backend.engine.tasks.task_bidding import project_board_task_status

                async with _board_patch_lock:
                    _board_patch_status_attempts += 1
                projection_extra_updates: Dict[str, Any] = {}
                projection_fields = (
                    "deliverables",
                    "changed_files",
                    "rollback_hint",
                    "blocked_reason",
                    "missing_information",
                    "bids",
                    "auto_assign",
                    "bid_deadline",
                    "relay_id",
                    "origin_role",
                    "target_role",
                    "relay_status",
                    "relay_type",
                    "relay_context",
                    "description",
                )
                for field in projection_fields:
                    if field in body:
                        projection_extra_updates[field] = val.get(field)
                if "description" in body:
                    projection_extra_updates["description"] = val.get("description")
                if "blocked_at" in val:
                    projection_extra_updates["blocked_at"] = val.get("blocked_at")
                if "recovered_at" in val:
                    projection_extra_updates["recovered_at"] = val.get("recovered_at")

                projection_kwargs: Dict[str, Any] = {
                    "thread_id": str(val.get("thread_id") or "") or None,
                    "result": (str(val.get("result") or "") if "result" in body else None),
                    "progress": (int(val.get("progress")) if isinstance(val.get("progress"), (int, float)) else None),
                    "progress_message": (str(val.get("progress_message") or "") if "progress_message" in body else None),
                    "dispatch_state": (str(val.get("dispatch_state") or "") if "dispatch_state" in body else None),
                    "source": "board_api_patch",
                    "extra_updates": projection_extra_updates or None,
                }
                if "claimed_by" in body:
                    projection_kwargs["claimed_by"] = val.get("claimed_by")
                projected = await asyncio.to_thread(
                    project_board_task_status,
                    task_id,
                    str(val.get("status") or ""),
                    scope,
                    **projection_kwargs,
                )
                if not projected:
                    async with _board_patch_lock:
                        _board_patch_status_conflicts += 1
                    raise HTTPException(status_code=409, detail="任务状态已变化，无法完成更新")
                latest = await _store_get(store, ns, task_id)
                latest_raw = getattr(latest, "value", latest) if not isinstance(latest, dict) else latest
                val = dict(latest_raw) if isinstance(latest_raw, dict) else val
        else:
            from backend.engine.tasks.task_bidding import project_board_task_status, is_task_single_source_enabled

            if is_task_single_source_enabled() and body.get("status"):
                async with _board_patch_lock:
                    _board_patch_status_attempts += 1
                projection_fields = (
                    "deliverables", "changed_files", "rollback_hint", "blocked_reason", "missing_information",
                    "bids", "auto_assign", "bid_deadline", "relay_id", "origin_role", "target_role",
                    "relay_status", "relay_type", "relay_context", "description",
                )
                projection_extra_updates = {k: val.get(k) for k in projection_fields if k in val}
                if "description" in body:
                    projection_extra_updates["description"] = val.get("description")
                projection_kwargs_else: Dict[str, Any] = {
                    "thread_id": val.get("thread_id"),
                    "result": val.get("result") if "result" in body else None,
                    "progress": int(val["progress"]) if isinstance(val.get("progress"), (int, float)) else None,
                    "progress_message": str(val.get("progress_message") or "") if "progress_message" in body else None,
                    "dispatch_state": str(val.get("dispatch_state") or "") if "dispatch_state" in body else None,
                    "source": "board_api_patch",
                    "extra_updates": projection_extra_updates or None,
                }
                if "claimed_by" in body:
                    projection_kwargs_else["claimed_by"] = val.get("claimed_by")
                projected = await asyncio.to_thread(
                    project_board_task_status,
                    task_id,
                    now_status_norm,
                    scope,
                    **projection_kwargs_else,
                )
                if not projected:
                    async with _board_patch_lock:
                        _board_patch_status_conflicts += 1
                    raise HTTPException(status_code=409, detail="任务状态已变化，无法完成更新")
                latest = await _store_get(store, ns, task_id)
                latest_raw = getattr(latest, "value", latest) if not isinstance(latest, dict) else latest
                val = dict(latest_raw) if isinstance(latest_raw, dict) else val
            else:
                recheck = await _store_get(store, ns, task_id)
                if recheck:
                    recheck_raw = getattr(recheck, "value", recheck) if not isinstance(recheck, dict) else recheck
                    recheck_val = dict(recheck_raw) if isinstance(recheck_raw, dict) else {}
                    recheck_exec = _ensure_execution_state(recheck_val)
                    recheck_ver = int(recheck_exec.get("state_version", 0) or 0)
                    if recheck_ver > base_state_version:
                        raise HTTPException(status_code=409, detail="任务已被并发更新，请刷新后重试")
                val["updated_at"] = now_iso
                await _store_put(store, ns, task_id, val)
        _board_list_cache.pop(scope, None)
        return {"ok": True, "task": {"id": task_id, **val}}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("看板更新任务失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class BoardTaskResumeBody(BaseModel):
    scope: Optional[str] = "personal"
    reason: Optional[str] = "manual_resume"
    thread_id: Optional[str] = None
    run_id: Optional[str] = None
    force_prompt_fallback: Optional[bool] = False


class BoardTaskStepCompleteBody(BaseModel):
    scope: Optional[str] = "personal"
    step_id: str
    step_seq: Optional[int] = 0
    event_seq: Optional[int] = 0
    result_digest: Optional[str] = ""


@router.get("/board/tasks/{task_id}/execution-state")
async def board_task_execution_state(task_id: str = Depends(_validate_task_id), scope: str = "personal"):
    try:
        from backend.engine.core.main_graph import get_sqlite_store

        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ns = _board_ns_for_scope(scope)
        out = await _store_get(store, ns, task_id)
        if not out:
            raise HTTPException(status_code=404, detail="任务不存在")
        raw = getattr(out, "value", out) if not isinstance(out, dict) else out
        val = dict(raw) if isinstance(raw, dict) else {}
        execution = _ensure_execution_state(val)
        return {
            "ok": True,
            "state": {
                "task_id": task_id,
                "status": str(val.get("status") or ""),
                "thread_id": str(val.get("thread_id") or "") or None,
                "run_id": str(execution.get("active_run_id") or "") or None,
                "execution": execution,
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("读取执行状态失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.post("/board/tasks/{task_id}/resume")
async def board_task_resume(task_id: str = Depends(_validate_task_id), body: BoardTaskResumeBody = Body(...), _: None = Depends(verify_internal_token)):
    try:
        from backend.engine.core.main_graph import get_sqlite_store

        scope = str(body.scope or "personal")
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ns = _board_ns_for_scope(scope)
        out = await _store_get(store, ns, task_id)
        if not out:
            raise HTTPException(status_code=404, detail="任务不存在")
        raw = getattr(out, "value", out) if not isinstance(out, dict) else out
        val = dict(raw) if isinstance(raw, dict) else {}
        execution = _ensure_execution_state(val)
        now_iso = datetime.now(timezone.utc).isoformat()
        current_status = str(val.get("status") or "").strip().lower()
        if current_status in {"completed", "cancelled"}:
            raise HTTPException(status_code=409, detail="已终态任务无法恢复")
        if current_status in {"running", "in_progress"}:
            return {
                "ok": True,
                "resumed": False,
                "mode": "already_running",
                "state": {
                    "task_id": task_id,
                    "status": current_status,
                    "thread_id": str(val.get("thread_id") or "") or None,
                    "run_id": str(execution.get("active_run_id") or "") or None,
                    "execution": execution,
                },
            }

        thread_id = str(body.thread_id or val.get("thread_id") or "").strip()
        resume_ok = False
        if thread_id and not bool(body.force_prompt_fallback) and is_valid_thread_id_uuid(thread_id):
            api_url = os.getenv("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")
            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(connect=3.0, read=8.0, write=5.0, pool=3.0)
                ) as client:
                    payload = {
                        "command": {
                            "resume": {
                                "decision": "approve",
                                "feedback": str(body.reason or "manual_resume"),
                                "task_id": task_id,
                                "recovery_point": execution.get("recovery_point"),
                            }
                        }
                    }
                    resp = await client.post(f"{api_url}/threads/{thread_id}/runs", json=payload)
                    if resp.status_code < 400:
                        resume_ok = True
            except Exception:
                resume_ok = False

        if not resume_ok:
            _fire_and_forget_dispatch(task_id=task_id, scope=scope, reason=str(body.reason or "manual_resume_fallback"))
            val["status"] = "available"
        else:
            val["status"] = "running"
        val["updated_at"] = now_iso
        execution["recovery_available"] = False
        execution["recovery_reason"] = ""
        execution["active_run_id"] = str(body.run_id or execution.get("active_run_id") or "") or None
        execution["state_version"] = int(execution.get("state_version", 0) or 0) + 1
        execution["updated_at"] = now_iso
        val["execution"] = execution
        await _store_put(store, ns, task_id, val)
        return {
            "ok": True,
            "resumed": True,
            "mode": "thread_resume" if resume_ok else "dispatch_fallback",
            "state": {
                "task_id": task_id,
                "status": str(val.get("status") or ""),
                "thread_id": thread_id or None,
                "run_id": str(execution.get("active_run_id") or "") or None,
                "execution": execution,
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("任务恢复失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.post("/board/tasks/{task_id}/runs/{run_id}/step-complete")
async def board_task_step_complete(task_id: str = Depends(_validate_task_id), run_id: str = "", body: BoardTaskStepCompleteBody = Body(...), _: None = Depends(verify_internal_token)):
    try:
        from backend.engine.core.main_graph import get_sqlite_store

        scope = str(body.scope or "personal")
        step_id = str(body.step_id or "").strip()
        if not step_id:
            raise HTTPException(status_code=400, detail="step_id 必填")
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ns = _board_ns_for_scope(scope)
        out = await _store_get(store, ns, task_id)
        if not out:
            raise HTTPException(status_code=404, detail="任务不存在")
        raw = getattr(out, "value", out) if not isinstance(out, dict) else out
        val = dict(raw) if isinstance(raw, dict) else {}
        execution = _ensure_execution_state(val)
        completed = execution.get("completed_step_ids")
        if not isinstance(completed, list):
            completed = []
        deduped = step_id in completed
        if not deduped:
            completed.append(step_id)
            execution["completed_step_ids"] = completed[-200:]
            try:
                execution["last_success_step_seq"] = max(
                    int(execution.get("last_success_step_seq", 0) or 0),
                    int(body.step_seq or 0),
                )
            except Exception:
                execution["last_success_step_seq"] = int(execution.get("last_success_step_seq", 0) or 0)
            execution["recovery_point"] = {
                "step_id": step_id,
                "seq": int(body.step_seq or 0),
                "at": datetime.now(timezone.utc).isoformat(),
                "reason": "step_complete",
            }
        execution["active_run_id"] = run_id
        execution["last_event_seq"] = max(int(execution.get("last_event_seq", 0) or 0), int(body.event_seq or 0))
        execution["state_version"] = int(execution.get("state_version", 0) or 0) + 1
        execution["updated_at"] = datetime.now(timezone.utc).isoformat()
        val["execution"] = execution
        val["updated_at"] = execution["updated_at"]
        await _store_put(store, ns, task_id, val)
        return {
            "ok": True,
            "deduped": deduped,
            "state": {
                "task_id": task_id,
                "status": str(val.get("status") or ""),
                "thread_id": str(val.get("thread_id") or "") or None,
                "run_id": run_id,
                "execution": execution,
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("记录步骤完成失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class BoardTaskProgressBody(BaseModel):
    progress: int
    message: Optional[str] = ""

    @field_validator("progress")
    @classmethod
    def clamp_progress(cls, v: Union[int, float]) -> int:
        return max(0, min(100, int(v) if v is not None else 0))


@router.post("/board/tasks/{task_id}/progress")
async def board_report_progress(task_id: str = Depends(_validate_task_id), body: BoardTaskProgressBody = Body(...), scope: str = "personal", _: None = Depends(verify_internal_token)):
    """报告任务进度（0-100 + 文字说明）。"""
    try:
        from datetime import datetime, timezone
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ns = _board_ns_for_scope(scope)
        out = await _store_get(store, ns, task_id)
        if not out:
            raise HTTPException(status_code=404, detail="任务不存在")
        v = getattr(out, "value", out) if not isinstance(out, dict) else out
        val = dict(v) if isinstance(v, dict) else {}
        val["progress"] = max(0, min(100, body.progress))
        val["progress_message"] = (body.message or "").strip() or None
        val["updated_at"] = datetime.now(timezone.utc).isoformat()
        await _store_put(store, ns, task_id, val)
        return {"ok": True, "task": {"id": task_id, **val}}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("报告进度失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class BoardBlockedBody(BaseModel):
    reason: str
    missing_info: Optional[List[str]] = None


@router.post("/board/tasks/{task_id}/blocked")
async def board_report_blocked(task_id: str = Depends(_validate_task_id), body: BoardBlockedBody = Body(...), scope: str = "personal", _: None = Depends(verify_internal_token)):
    """报告任务阻塞原因与缺失信息。"""
    try:
        from datetime import datetime, timezone
        from backend.engine.core.main_graph import get_sqlite_store
        from backend.engine.tasks.task_bidding import project_board_task_status, is_task_single_source_enabled

        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ns = _board_ns_for_scope(scope)
        out = await _store_get(store, ns, task_id)
        if not out:
            raise HTTPException(status_code=404, detail="任务不存在")
        v = getattr(out, "value", out) if not isinstance(out, dict) else out
        val = dict(v) if isinstance(v, dict) else {}
        blocked_reason = str(body.reason or "").strip()[:500]
        missing_information = [
            str(x).strip()[:300] for x in (body.missing_info or []) if str(x).strip()
        ]
        progress_message = f"任务阻塞：{blocked_reason}" if blocked_reason else "任务阻塞，等待补充信息"
        blocked_at = datetime.now(timezone.utc).isoformat()
        if is_task_single_source_enabled():
            try:
                projected = await asyncio.to_thread(
                    project_board_task_status,
                    task_id,
                    "blocked",
                    scope,
                    thread_id=str(val.get("thread_id") or "") or None,
                    progress=(int(val.get("progress")) if isinstance(val.get("progress"), (int, float)) else None),
                    progress_message=progress_message,
                    dispatch_state=str(val.get("dispatch_state") or "") or None,
                    claimed_by=(str(val.get("claimed_by") or "") or None),
                    source="blocked_api",
                    extra_updates={
                        "blocked_reason": blocked_reason,
                        "missing_information": missing_information,
                        "blocked_at": blocked_at,
                        "recovered_at": None,
                    },
                )
                if not projected:
                    raise HTTPException(status_code=409, detail="任务状态冲突，无法写入 blocked")
                latest = await _store_get(store, ns, task_id)
                latest_raw = getattr(latest, "value", latest) if not isinstance(latest, dict) else latest
                val = dict(latest_raw) if isinstance(latest_raw, dict) else val
            except Exception as projection_err:
                if isinstance(projection_err, HTTPException):
                    raise
                logger.debug("blocked status projection failed: %s", projection_err)
                raise HTTPException(status_code=500, detail="blocked 状态写入失败")
        else:
            current_status = str(val.get("status") or "").strip().lower()
            if not _is_valid_board_transition(current_status, "blocked"):
                raise HTTPException(status_code=400, detail="非法状态迁移至 blocked")
            val["status"] = "blocked"
            val["blocked_reason"] = blocked_reason
            val["missing_information"] = missing_information
            val["blocked_at"] = blocked_at
            val["recovered_at"] = None
            val["progress_message"] = progress_message
            val["updated_at"] = datetime.now(timezone.utc).isoformat()
            await _store_put(store, ns, task_id, val)
        return {"ok": True, "task": {"id": task_id, **val}}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("报告任务阻塞失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class BoardArtifactsBody(BaseModel):
    deliverables: Optional[List[str]] = None
    changed_files: Optional[List[str]] = None
    rollback_hint: Optional[str] = ""


@router.post("/board/tasks/{task_id}/artifacts")
async def board_report_artifacts(task_id: str = Depends(_validate_task_id), body: BoardArtifactsBody = Body(...), scope: str = "personal", _: None = Depends(verify_internal_token)):
    """上报任务成果物、变更文件与回滚提示。deliverables/changed_files 传空数组表示清空，不传则保留原值。"""
    try:
        from datetime import datetime, timezone
        from backend.engine.core.main_graph import get_sqlite_store

        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ns = _board_ns_for_scope(scope)
        out = await _store_get(store, ns, task_id)
        if not out:
            raise HTTPException(status_code=404, detail="任务不存在")
        v = getattr(out, "value", out) if not isinstance(out, dict) else out
        val = dict(v) if isinstance(v, dict) else {}
        current_status = str(val.get("status") or "").strip().lower()
        if current_status not in {"running", "in_progress", "waiting_human", "completed"}:
            raise HTTPException(status_code=400, detail="当前状态不允许上报成果物")
        # 传空数组表示清空；不传（None）表示不修改该字段
        # 传空数组表示清空对应字段；不传（None）表示不更新、保留原值
        if body.deliverables is not None:
            val["deliverables"] = [str(x).strip() for x in body.deliverables if str(x).strip()]
        if body.changed_files is not None:
            val["changed_files"] = [str(x).strip() for x in body.changed_files if str(x).strip()]
        if body.rollback_hint is not None:
            val["rollback_hint"] = str(body.rollback_hint or "").strip()
        val["updated_at"] = datetime.now(timezone.utc).isoformat()
        await _store_put(store, ns, task_id, val)
        return {"ok": True, "task": {"id": task_id, **val}}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("上报任务成果物失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class RelayTaskBody(BaseModel):
    from_role: str
    to_role: str
    relay_type: Optional[str] = "delegate"
    context: Optional[Dict[str, Any]] = None


@router.post("/board/tasks/{task_id}/relay")
async def board_relay_task(task_id: str = Depends(_validate_task_id), body: RelayTaskBody = Body(...), scope: str = "personal", _: None = Depends(verify_internal_token)):
    """创建任务中继（委派/转派）。"""
    try:
        from backend.engine.tasks.task_relay import relay_task

        res = await asyncio.to_thread(
            relay_task,
            task_id=task_id,
            from_role=body.from_role,
            to_role=body.to_role,
            context=body.context or {},
            relay_type=body.relay_type or "delegate",
            scope=scope,
        )
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("error", "中继失败"))
        return {"ok": True, **res}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("任务中继失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.post("/board/relay/{relay_id}/accept")
async def board_accept_relay(relay_id: str, agent_id: str, scope: str = "personal", _: None = Depends(verify_internal_token)):
    """接受中继任务。"""
    try:
        from backend.engine.tasks.task_relay import accept_relay

        res = await asyncio.to_thread(accept_relay, relay_id=relay_id, accepting_role=agent_id, scope=scope)
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("error", "接受中继失败"))
        return {"ok": True, **res}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("接受中继失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.post("/board/relay/{relay_id}/complete")
async def board_complete_relay(relay_id: str, result: str = "", scope: str = "personal", _: None = Depends(verify_internal_token)):
    """完成中继任务。"""
    try:
        from backend.engine.tasks.task_relay import complete_relay

        res = await asyncio.to_thread(complete_relay, relay_id=relay_id, result=result, scope=scope)
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("error", "完成中继失败"))
        return {"ok": True, **res}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("完成中继失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.get("/board/tasks/{task_id}/bids")
async def board_get_bids(task_id: str = Depends(_validate_task_id), scope: str = "personal"):
    """获取任务的竞标列表（自治认领模式）。"""
    try:
        from backend.engine.tasks.task_bidding import get_bids
        bids = await asyncio.to_thread(get_bids, task_id, scope=scope)
        return {"ok": True, "task_id": task_id, "bids": bids}
    except Exception as e:
        logger.exception("获取竞标列表失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class BoardBidBody(BaseModel):
    agent_id: str
    confidence: Optional[float] = None
    reason: Optional[str] = ""
    estimated_effort: Optional[str] = "medium"

    @field_validator("estimated_effort")
    @classmethod
    def estimated_effort_enum(cls, v: Optional[str]) -> str:
        if not v or not v.strip():
            return "medium"
        x = v.strip().lower()
        if x in ("low", "medium", "high"):
            return x
        return "medium"


@router.post("/board/tasks/{task_id}/bids")
async def board_submit_bid(request: Request, task_id: str = Depends(_validate_task_id), body: BoardBidBody = Body(...), scope: str = "personal", _: None = Depends(verify_internal_token)):
    """Agent 提交竞标。请求头 X-Agent-Id 必须与 body.agent_id 一致，防止冒充其他 Agent。"""
    claimed = (request.headers.get("X-Agent-Id") or "").strip()
    agent_id = (body.agent_id or "").strip()
    if not agent_id:
        raise HTTPException(status_code=400, detail="agent_id 必填")
    if claimed != agent_id:
        raise HTTPException(status_code=403, detail="X-Agent-Id 与 body.agent_id 不一致，无法代他人提交竞标")
    try:
        from backend.engine.tasks.task_bidding import submit_bid
        bid = {
            "confidence": body.confidence if body.confidence is not None else 0.5,
            "reason": body.reason or "",
            "estimated_effort": body.estimated_effort or "medium",
        }
        await submit_bid(task_id, body.agent_id, bid, scope=scope)
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
        val = None
        if store is not None:
            ns = _board_ns_for_scope(scope)
            out = await asyncio.to_thread(store.get, ns, task_id)
            if out is not None:
                val = getattr(out, "value", out) if not isinstance(out, dict) else out
        return {"ok": True, "task_id": task_id, "agent_id": body.agent_id, "task": {"id": task_id, **val} if isinstance(val, dict) else None}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_safe_error_detail(e))
    except Exception as e:
        logger.exception("提交竞标失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class AcceptBidBody(BaseModel):
    agent_id: Optional[str] = None
    strategy: Optional[str] = "fair_weighted"


@router.post("/board/tasks/{task_id}/accept-bid")
async def board_accept_bid(task_id: str = Depends(_validate_task_id), body: AcceptBidBody = Body(...), scope: str = "personal", _: None = Depends(verify_internal_token)):
    """确认竞标：指定 agent_id 或按 strategy 自动选择最优竞标者。"""
    try:
        from backend.engine.tasks.task_bidding import resolve_bids, get_bids, project_board_task_status
        from backend.engine.tasks.task_watcher import dispatch_task_once
        if body.agent_id:
            from backend.engine.core.main_graph import get_sqlite_store
            bids = await asyncio.to_thread(get_bids, task_id, scope=scope)
            if not any(b.get("agent_id") == body.agent_id for b in bids):
                raise HTTPException(status_code=400, detail="该 Agent 未竞标此任务")
            store = get_sqlite_store()
            if store is None:
                raise HTTPException(status_code=503, detail="Store 不可用")
            ns = _board_ns_for_scope(scope)
            out = await _store_get(store, ns, task_id)
            if not out:
                raise HTTPException(status_code=404, detail="任务不存在")
            raw = getattr(out, "value", out) if not isinstance(out, dict) else out
            current = dict(raw) if isinstance(raw, dict) else {}
            current_status = str(current.get("status") or "").strip().lower()
            current_claimed_by = str(current.get("claimed_by") or "").strip()
            if current_status == "claimed" and current_claimed_by and current_claimed_by != body.agent_id:
                raise HTTPException(status_code=409, detail=f"任务已被其他角色认领: {current_claimed_by}")
            project_kwargs: Dict[str, Any] = {
                "claimed_by": body.agent_id,
                "source": "accept_bid_api",
                "only_when_status_in": {"available", "bidding", "pending", "claimed"},
            }
            if current_status == "claimed":
                project_kwargs["only_when_claimed_by"] = current_claimed_by
            projected = await asyncio.to_thread(
                project_board_task_status,
                task_id,
                "claimed",
                scope,
                **project_kwargs,
            )
            if not projected:
                raise HTTPException(status_code=409, detail="任务状态已变化，无法确认竞标")
            dispatch_result = await dispatch_task_once(task_id=task_id, scope=scope, preferred_role_id=body.agent_id)
            return {
                "ok": True,
                "task_id": task_id,
                "claimed_by": body.agent_id,
                "dispatch_state": dispatch_result.get("state") if isinstance(dispatch_result, dict) else "unknown",
            }
        result = await resolve_bids(task_id, strategy=body.strategy or "fair_weighted", scope=scope)
        if not result.get("ok"):
            raise HTTPException(status_code=400, detail=result.get("error", "无竞标"))
        claimed_by = str(result.get("claimed_by") or "").strip()
        dispatch_result = await dispatch_task_once(task_id=task_id, scope=scope, preferred_role_id=claimed_by)
        return {
            "ok": True,
            "task_id": task_id,
            "claimed_by": result.get("claimed_by"),
            "bid": result.get("bid"),
            "dispatch_state": dispatch_result.get("state") if isinstance(dispatch_result, dict) else "unknown",
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("确认竞标失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.post("/board/tasks/{task_id}/auto-assign")
async def board_auto_assign(task_id: str = Depends(_validate_task_id), strategy: str = "fair_weighted", scope: str = "personal", _: None = Depends(verify_internal_token)):
    """触发自动选择最优竞标者。"""
    try:
        from backend.engine.tasks.task_bidding import resolve_bids
        from backend.engine.tasks.task_watcher import dispatch_task_once
        result = await resolve_bids(task_id, strategy=strategy, scope=scope)
        if not result.get("ok"):
            raise HTTPException(status_code=400, detail=result.get("error", "无竞标"))
        claimed_by = str(result.get("claimed_by") or "").strip()
        dispatch_result = await dispatch_task_once(task_id=task_id, scope=scope, preferred_role_id=claimed_by)
        return {
            "ok": True,
            "task_id": task_id,
            "claimed_by": result.get("claimed_by"),
            "bid": result.get("bid"),
            "dispatch_state": dispatch_result.get("state") if isinstance(dispatch_result, dict) else "unknown",
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("自动分配失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class SuggestRoleBody(BaseModel):
    subject: str = ""
    required_skills: Optional[List[str]] = None


@router.post("/board/tasks/suggest-role", deprecated=True)
async def board_suggest_role(body: SuggestRoleBody, _: None = Depends(verify_internal_token)):
    """[已废弃] 中央调度推荐角色，请改用自治认领：发布任务后通过 GET /board/tasks/{id}/bids 查看竞标，POST accept-bid 确认。保留为无 Agent 在线时的降级。"""
    try:
        from backend.engine.tasks.task_router import suggest_role_for_task
        result = suggest_role_for_task(
            subject=body.subject,
            required_skills=body.required_skills,
        )
        return {"ok": True, **result}
    except Exception as e:
        logger.exception("任务推荐角色失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.get("/board/tasks/{task_id}/subtasks")
async def board_get_subtasks(task_id: str = Depends(_validate_task_id), scope: str = "personal"):
    """获取任务的子任务列表。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ns = _board_ns_for_scope(scope)
        rows = await _store_list_items(store, ns, limit=500)
        subtasks = [{"id": row.get("id", ""), **row} for row in rows if row.get("parent_task_id") == task_id]
        return {"ok": True, "task_id": task_id, "subtasks": subtasks, "truncated": len(rows) >= 500}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("获取子任务失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class HumanReviewBody(BaseModel):
    checkpoint_id: str
    decision: str
    feedback: Optional[str] = ""


def _normalize_human_checkpoints(raw: Any) -> List[dict]:
    items = raw if isinstance(raw, list) else []
    normalized: List[dict] = []
    for idx, cp in enumerate(items):
        if not isinstance(cp, dict):
            continue
        after_step = str(cp.get("after_step") or "step").strip() or "step"
        action = str(cp.get("action") or "review").strip() or "review"
        checkpoint_id = str(cp.get("checkpoint_id") or f"{after_step}-{action}-{idx}").strip() or f"{after_step}-{action}-{idx}"
        status = str(cp.get("status") or "pending").strip().lower() or "pending"
        if status not in {"pending", "approved", "rejected"}:
            status = "pending"
        normalized.append(
            {
                "checkpoint_id": checkpoint_id,
                "after_step": cp.get("after_step"),
                "action": cp.get("action"),
                "description": cp.get("description"),
                "options": cp.get("options") if isinstance(cp.get("options"), list) else None,
                "status": status,
                "last_decision": cp.get("last_decision"),
                "reviewed_at": cp.get("reviewed_at"),
            }
        )
    return normalized


@router.post("/board/tasks/{task_id}/human-review")
async def board_submit_human_review(request: Request, task_id: str = Depends(_validate_task_id), body: HumanReviewBody = Body(...), scope: str = "personal", _: None = Depends(verify_internal_token)):
    """提交人类审核结果（记录到任务并供后续流程使用）。需配置 INTERNAL_API_TOKEN 时带 X-Internal-Token 头。"""
    try:
        from datetime import datetime, timezone
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ns = _board_ns_for_scope(scope)
        out = await _store_get(store, ns, task_id)
        if not out:
            raise HTTPException(status_code=404, detail="任务不存在")
        v = getattr(out, "value", out) if not isinstance(out, dict) else out
        val = dict(v) if isinstance(v, dict) else {}
        checkpoints = _normalize_human_checkpoints(val.get("human_checkpoints"))
        decision_raw = str(body.decision or "").strip().lower()
        decision_alias = {
            "approve": "approve",
            "approved": "approve",
            "pass": "approve",
            "reject": "reject",
            "rejected": "reject",
            "fail": "reject",
            "revise": "revise",
            "changes_requested": "revise",
            "request_changes": "revise",
            "delegate": "delegate",
            "skip": "skip",
        }
        decision = decision_alias.get(decision_raw)
        if decision is None:
            raise HTTPException(status_code=400, detail="decision 必须是 approve/reject/revise/delegate/skip")
        checkpoint_status = (
            "approved" if decision == "approve"
            else "revision_requested" if decision == "revise"
            else "delegated" if decision == "delegate"
            else "skipped" if decision == "skip"
            else "rejected"
        )
        matched = False
        now_iso = datetime.now(timezone.utc).isoformat()
        for cp in checkpoints:
            if str(cp.get("checkpoint_id") or "").strip() == str(body.checkpoint_id).strip():
                cp["status"] = checkpoint_status
                cp["last_decision"] = decision
                cp["reviewed_at"] = now_iso
                matched = True
                break
        if not matched:
            checkpoints.append(
                {
                    "checkpoint_id": str(body.checkpoint_id).strip(),
                    "after_step": None,
                    "action": "review",
                    "description": None,
                    "status": checkpoint_status,
                    "last_decision": decision,
                    "reviewed_at": now_iso,
                }
            )
        val["human_checkpoints"] = checkpoints
        reviews = val.get("human_reviews") or []
        if not isinstance(reviews, list):
            reviews = []
        reviews.append({
            "checkpoint_id": body.checkpoint_id,
            "decision": decision,
            "feedback": (body.feedback or "").strip(),
            "at": now_iso,
        })
        val["human_reviews"] = reviews
        decision_points = val.get("decision_points") or []
        if not isinstance(decision_points, list):
            decision_points = []
        decision_points.append(
            {
                "type": "human_checkpoint",
                "checkpoint_id": body.checkpoint_id,
                "decision": decision,
                "feedback": (body.feedback or "").strip(),
                "at": now_iso,
            }
        )
        val["decision_points"] = decision_points

        prev_status = str(val.get("status") or "").strip().lower()
        current_thread_id = str(val.get("thread_id") or "").strip()
        has_rejected = any(str(cp.get("status") or "").lower() == "rejected" for cp in checkpoints)
        has_pending = any(str(cp.get("status") or "").lower() == "pending" for cp in checkpoints)
        if decision in {"reject", "revise", "delegate"}:
            val["status"] = "paused"
            val["progress_message"] = (
                f"检查点 {body.checkpoint_id} 需要修正，等待处理后继续"
                if decision == "revise"
                else (
                    f"检查点 {body.checkpoint_id} 已委派处理，等待后续继续"
                    if decision == "delegate"
                    else f"检查点 {body.checkpoint_id} 被驳回，等待修正后继续"
                )
            )
        elif decision == "skip":
            if current_thread_id and prev_status in {"running", "claimed", "waiting_human", "paused"}:
                val["status"] = "running"
                val["progress_message"] = f"检查点 {body.checkpoint_id} 已跳过，继续执行"
            else:
                # 未绑定执行线程时不能直接写 running，改为 available 交由分发链路继续。
                val["status"] = "available"
                val["progress_message"] = f"检查点 {body.checkpoint_id} 已跳过，任务等待继续分发"
        elif not has_rejected and not has_pending and checkpoints:
            if str(val.get("status") or "") in {"paused", "waiting_human", "running", "claimed"}:
                # 仅解除人工阻塞，避免无执行线程任务进入“假 running”
                val["status"] = "available"
            val["progress_message"] = "人类检查点全部通过，可继续执行"
        elif has_pending and str(val.get("status") or "") in {"running", "claimed"}:
            val["status"] = "waiting_human"
            val["progress_message"] = "等待人工确认检查点"

        status_after_review = str(val.get("status") or "").strip().lower()
        status_changed = status_after_review != prev_status
        val["updated_at"] = now_iso
        should_dispatch_after_review = bool(
            status_after_review == "available"
            and not has_pending
            and not has_rejected
        )
        if status_changed:
            try:
                from backend.engine.tasks.task_bidding import project_board_task_status

                projected = await asyncio.to_thread(
                    project_board_task_status,
                    task_id,
                    status_after_review,
                    scope,
                    thread_id=str(val.get("thread_id") or "") or None,
                    progress=(int(val.get("progress")) if isinstance(val.get("progress"), (int, float)) else None),
                    progress_message=str(val.get("progress_message") or ""),
                    dispatch_state=str(val.get("dispatch_state") or "") or None,
                    claimed_by=(str(val.get("claimed_by") or "") or None),
                    source="human_review",
                    extra_updates={
                        "human_checkpoints": checkpoints,
                        "human_reviews": reviews,
                        "decision_points": decision_points,
                    },
                )
                if not projected:
                    raise HTTPException(status_code=409, detail="任务状态冲突，无法提交审核结果")
                latest = await _store_get(store, ns, task_id)
                latest_raw = getattr(latest, "value", latest) if not isinstance(latest, dict) else latest
                val = dict(latest_raw) if isinstance(latest_raw, dict) else val
            except HTTPException:
                raise
            except Exception as projection_err:
                logger.debug("human-review status projection failed: %s", projection_err)
                raise HTTPException(status_code=500, detail="human-review 状态写入失败")
        else:
            await _store_put(store, ns, task_id, val)
        if should_dispatch_after_review:
            thread_id = str(val.get("thread_id") or "").strip()
            if thread_id and is_valid_thread_id_uuid(thread_id):
                try:
                    import httpx

                    api_url = os.environ.get("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")
                    resume_payload = {"command": {"resume": {"decision": decision, "feedback": (body.feedback or "").strip()}}}
                    async with httpx.AsyncClient(
                        timeout=httpx.Timeout(connect=3.0, read=15.0, write=5.0, pool=3.0)
                    ) as client:
                        resp = await client.post(f"{api_url}/threads/{thread_id}/runs", json=resume_payload)
                    if resp.status_code >= 400:
                        raise RuntimeError(f"resume run failed: HTTP {resp.status_code}")
                except Exception as resume_err:
                    logger.debug("人工审核恢复 run 失败，回退即时分发 task_id=%s: %s", task_id, resume_err)
                    _fire_and_forget_dispatch(task_id=task_id, scope=scope, reason="human_review_passed_fallback")
            else:
                _fire_and_forget_dispatch(task_id=task_id, scope=scope, reason="human_review_passed")
        return {"ok": True, "task": {"id": task_id, **val}}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("提交人类审核失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


# ============================================================
# Agent 能力档案与任务评估
# ============================================================

@router.get("/board/capabilities")
async def board_capabilities(profile_id: Optional[str] = None):
    """Agent 能力摘要（来自 skill_profiles.json），供前端能力名片展示。"""
    try:
        path = get_api_project_root() / "backend" / "config" / "skill_profiles.json"
        if not path.exists():
            return {"ok": True, "profiles": {}, "capabilities_summary": ""}
        text = await asyncio.to_thread(path.read_text, encoding="utf-8")
        data = json.loads(text)
        profiles = data.get("profiles", {})
        result = []
        for pid, p in profiles.items():
            result.append({
                "id": pid,
                "label": p.get("label", pid),
                "description": p.get("description", ""),
                "capabilities_summary": p.get("capabilities_summary", ""),
            })
        summary = ""
        if profile_id and profile_id in profiles:
            summary = profiles[profile_id].get("capabilities_summary", "")
        return {"ok": True, "profiles": result, "capabilities_summary": summary}
    except Exception as e:
        logger.exception("获取能力摘要失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.get("/board/connections")
async def board_connections():
    """渠道连接状态：local 基于 Store 可用性做真实健康检查，openclaw 为预留。"""
    import time
    channels = []

    # local：检查 LangGraph Store 是否可用并测延迟
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
        t0 = time.perf_counter()
        if store is not None:
            ns = _board_ns_for_scope("personal")
            await _store_list_keys(store, ns)
            latency_ms = round((time.perf_counter() - t0) * 1000)
            channels.append({"type": "local", "connected": True, "latency_ms": latency_ms})
        else:
            channels.append({"type": "local", "connected": False, "latency_ms": None})
    except Exception as e:
        logger.debug("board/connections local check: %s", e)
        channels.append({"type": "local", "connected": False, "latency_ms": None})

    # openclaw：当 agent_profile.network.openclaw_enabled 为 true 时出现，Phase 2 再实现连接
    try:
        from backend.engine.skills.skill_profiles import load_agent_profile
        profile = load_agent_profile()
        net = profile.get("network") or {}
        if net.get("openclaw_enabled"):
            channels.append({"type": "openclaw", "connected": False, "latency_ms": None})
    except Exception:
        pass

    return {"ok": True, "channels": channels}