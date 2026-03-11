"""
任务服务：基于 LangGraph Thread metadata 实现任务 CRUD 与执行。

Task = Thread：任务即带 is_task 元数据的 Thread，使用 LangGraph 原生 API。
通过 httpx 调用同机 LangGraph Server 的 REST API（threads / runs）。
"""

import atexit
import asyncio
import ipaddress
import os
import socket
import json
import logging
import threading
import uuid
import time
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

from backend.api.common import is_valid_thread_id_uuid

_http_client_lock = threading.Lock()
_sync_http_client: Optional[httpx.Client] = None
_sync_http_client_lock = threading.Lock()


def _get_sync_http_client() -> httpx.Client:
    """模块级同步 httpx 单例，供 update_task_status_sync 复用，避免每次新建。"""
    global _sync_http_client
    with _sync_http_client_lock:
        if _sync_http_client is None or _sync_http_client.is_closed:
            _sync_http_client = httpx.Client(timeout=10.0)
        return _sync_http_client


class TaskNotFoundError(Exception):
    """任务（thread）不存在或不可访问。"""
    pass

logger = logging.getLogger(__name__)

# LangGraph API 基地址（与前端 getApiUrl 一致，后端调用自身）
def _get_api_url() -> str:
    return os.environ.get("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")


_WEBHOOK_ALLOWED_SCHEMES = {"https"}
_WEBHOOK_BLOCKED_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
_WEBHOOK_METADATA_HOSTS = {"metadata.google.internal", "169.254.169.254", "metadata"}


def _validate_webhook_url(url: str) -> None:
    """校验 webhook URL，禁止内网/回环/非 HTTPS/云元数据域名，防止 SSRF。"""
    parsed = urlparse(url)
    if parsed.scheme not in _WEBHOOK_ALLOWED_SCHEMES:
        raise ValueError(f"webhook 仅允许 https，当前: {parsed.scheme}")
    host = (parsed.hostname or "").strip()
    if not host:
        raise ValueError("webhook 缺少 host")
    host_lower = host.lower()
    if host_lower in _WEBHOOK_BLOCKED_HOSTS:
        raise ValueError(f"webhook 不允许回环地址: {host}")
    if host_lower in _WEBHOOK_METADATA_HOSTS:
        raise ValueError(f"webhook 不允许云元数据地址: {host}")
    try:
        addr = ipaddress.ip_address(host)
        if addr.is_private or addr.is_loopback or addr.is_link_local:
            raise ValueError(f"webhook 不允许内网/链路本地地址: {host}")
    except ValueError as e:
        if "does not appear to be an IPv4 or IPv6 address" in str(e):
            try:
                infos = socket.getaddrinfo(host, None)
                for info in infos[:2]:
                    af, _, _, _, sockaddr = info
                    res = sockaddr[0]
                    if af == socket.AF_INET6 and res.startswith("::ffff:"):
                        res = res.replace("::ffff:", "")
                    try:
                        a = ipaddress.ip_address(res)
                        if a.is_private or a.is_loopback or a.is_link_local or a.is_reserved:
                            raise ValueError(f"webhook 域名解析到禁止地址: {host} -> {res}")
                    except ValueError:
                        pass
            except socket.gaierror:
                raise ValueError(f"webhook 无法解析 host: {host}")
        else:
            raise


def _get_http_client() -> httpx.AsyncClient:
    """模块级单例，复用连接池，避免每次 list_tasks 新建 client。"""
    with _http_client_lock:
        if not hasattr(_get_http_client, "_client") or _get_http_client._client is None:
            _get_http_client._client = httpx.AsyncClient(timeout=15.0)
        c = _get_http_client._client
        if c.is_closed:
            _get_http_client._client = httpx.AsyncClient(timeout=15.0)
            c = _get_http_client._client
        return c


def _close_http_client() -> None:
    """应用退出时关闭单例 client。atexit 时若事件循环仍在运行则 schedule aclose，否则 asyncio.run 关闭。"""
    with _http_client_lock:
        if hasattr(_get_http_client, "_client") and _get_http_client._client is not None:
            c = _get_http_client._client
            _get_http_client._client = None
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(c.aclose())
            except RuntimeError:
                try:
                    asyncio.run(c.aclose())
                except Exception as e:
                    logger.debug("task_service atexit aclose: %s", e)
            except Exception as e:
                logger.debug("task_service atexit get_running_loop: %s", e)


atexit.register(_close_http_client)


def _validate_thread_id(thread_id: str) -> None:
    """校验 thread_id 为合法 UUID，防止 URL 注入或非法路径。与 common.is_valid_thread_id_uuid 一致。"""
    if not thread_id or not isinstance(thread_id, str) or not thread_id.strip():
        raise ValueError("thread_id 不能为空")
    if not is_valid_thread_id_uuid(thread_id):
        raise ValueError("thread_id 必须是有效的 UUID 格式")


# ---------------------------------------------------------------------------
# 任务 metadata 约定（写入 thread.metadata）
# ---------------------------------------------------------------------------
TASK_META_IS_TASK = "is_task"
TASK_META_SUBJECT = "subject"
TASK_META_TASK_STATUS = "task_status"
TASK_META_PRIORITY = "priority"
TASK_META_SCENE = "scene"
TASK_META_MODE = "mode"
TASK_META_DELIVERABLES = "deliverables"
TASK_META_PARENT_TASK_ID = "parent_task_id"
TASK_META_CREATED_BY = "created_by"
TASK_META_RESULT_SUMMARY = "result_summary"
TASK_META_ERROR = "error"
TASK_META_STATUS_HISTORY = "task_status_history"
TASK_META_EXECUTION = "execution"
TASK_META_RECOVERY_POINT = "recovery_point"
TASK_META_COMPLETED_STEP_IDS = "completed_step_ids"

# update_task 仅允许写入以下 metadata 字段，防止任意字段绕过状态机
TASK_META_ALLOWED_UPDATE = frozenset({
    TASK_META_TASK_STATUS,
    TASK_META_RESULT_SUMMARY,
    TASK_META_ERROR,
    TASK_META_SUBJECT,
    TASK_META_PRIORITY,
    TASK_META_SCENE,
    TASK_META_MODE,
    TASK_META_DELIVERABLES,
    TASK_META_EXECUTION,
    TASK_META_RECOVERY_POINT,
    TASK_META_COMPLETED_STEP_IDS,
})

_TERMINAL_TASK_STATES = {"completed", "failed", "cancelled"}
_TASK_STATUS_TRANSITIONS = {
    "": {"pending", "running", "failed", "completed"},
    "pending": {"running", "failed", "cancelled"},
    "running": {"waiting_human", "completed", "failed", "cancelled", "paused"},
    "waiting_human": {"running", "failed", "cancelled"},
    "paused": {"running", "failed", "cancelled"},
    "completed": set(),
    "failed": set(),
    "cancelled": set(),
}


def _can_transition_task_status(current: str, target: str) -> bool:
    cur = str(current or "").strip().lower()
    nxt = str(target or "").strip().lower()
    if not nxt:
        return False
    if cur == nxt:
        return True
    allowed = _TASK_STATUS_TRANSITIONS.get(cur)
    if allowed is None:
        return cur not in _TERMINAL_TASK_STATES
    return nxt in allowed


def _append_status_history(meta: dict, from_status: str, to_status: str, source: str) -> None:
    history = meta.get(TASK_META_STATUS_HISTORY)
    if not isinstance(history, list):
        history = []
    history.append(
        {
            "from": str(from_status or ""),
            "to": str(to_status or ""),
            "at_ms": int(time.time() * 1000),
            "source": source,
        }
    )
    # 保留最近 30 条状态迁移记录，避免 metadata 无限增长。
    meta[TASK_META_STATUS_HISTORY] = history[-30:]


async def create_task(
    subject: str,
    description: str,
    config: Optional[dict] = None,
    priority: int = 3,
    created_by: str = "user",
    use_router: bool = False,
    required_skills: Optional[list] = None,
    background: bool = False,
    webhook: Optional[str] = None,
) -> dict:
    """创建任务 = 创建带 metadata 的 thread + 启动 run。
    
    Args:
        background: 为 True 时以后台模式启动 run（LangGraph Background Runs）
        webhook: 任务完成时回调通知的 URL
        use_router: 为 True 时按 subject/required_skills 推荐角色并设置 skill_profile
    """
    config = config or {}
    if use_router or (not config.get("skill_profile") and (subject or required_skills)):
        try:
            from backend.engine.tasks.task_router import suggest_role_for_task
            sug = suggest_role_for_task(subject=subject or description, required_skills=required_skills)
            if sug.get("role_id") and sug.get("skill_profile"):
                config["skill_profile"] = sug["skill_profile"]
                config["suggested_role_id"] = sug["role_id"]
        except Exception:
            pass
    if not config.get("skill_profile"):
        config.setdefault("skill_profile", config.get("scene", "full"))
    api_url = _get_api_url()
    meta = {
        TASK_META_IS_TASK: True,
        TASK_META_SUBJECT: subject[:200] if subject else "未命名任务",
        TASK_META_TASK_STATUS: "pending",
        TASK_META_STATUS_HISTORY: [],
        TASK_META_PRIORITY: priority,
        TASK_META_SCENE: config.get("scene", "full"),
        TASK_META_MODE: config.get("mode", "agent"),
        TASK_META_CREATED_BY: created_by,
        **({"role_id": str(config.get("role_id") or config.get("active_role_id") or "").strip()} if str(config.get("role_id") or config.get("active_role_id") or "").strip() else {}),
        **({"workspace_path": str(config["workspace_path"]).strip()} if config.get("workspace_path") else {}),
    }
    client = _get_http_client()
    # 1. 创建 thread（带任务 metadata）
    r = await client.post(
        f"{api_url}/threads",
        json={"metadata": meta},
    )
    r.raise_for_status()
    thread = r.json()
    thread_id = thread.get("thread_id")
    if not thread_id:
        raise ValueError("threads.create 未返回 thread_id")

    # 2. 启动 run（第一条消息 = 任务描述）
    mode = str(config.get("mode", "agent")).strip() or "agent"
    run_payload: dict = {
        "assistant_id": "agent",
        "input": {
            "messages": [
                {"type": "human", "content": description or subject},
            ],
        },
        "config": {
            "run_name": f"task_{mode}",
            "configurable": {
                "thread_id": thread_id,
                "request_id": str(config.get("request_id") or uuid.uuid4()),
                "request_enqueued_at": config.get("request_enqueued_at") or int(time.time() * 1000),
                "session_id": config.get("session_id") or thread_id,
                "task_key": config.get("task_key") or thread_id,
                "mode": config.get("mode", "agent"),
                "skill_profile": config.get("skill_profile", config.get("scene", "full")),
                "cost_tier": config.get("cost_tier", "medium"),
                **({"workspace_path": str(config["workspace_path"]).strip()} if config.get("workspace_path") else {}),
                **({"task_type": config.get("task_type")} if config.get("task_type") else {}),
                **({"workspace_domain": config.get("workspace_domain")} if config.get("workspace_domain") else {}),
                **({"business_domain": config.get("business_domain")} if config.get("business_domain") else {}),
                **({"license_tier": config.get("license_tier")} if config.get("license_tier") else {}),
            },
        },
        "stream_mode": [],
    }
    if background:
        run_payload["background"] = True
    if webhook:
        _validate_webhook_url(webhook)
        run_payload["webhook"] = webhook
    _append_status_history(meta, "pending", "running", "create_task")
    meta[TASK_META_TASK_STATUS] = "running"
    r = await client.patch(
        f"{api_url}/threads/{thread_id}",
        json={"metadata": meta},
    )
    r.raise_for_status()
    # 2b. 启动 run；失败时回滚 metadata 为 failed，避免任务卡在 running
    try:
        r2 = await client.post(
            f"{api_url}/threads/{thread_id}/runs",
            json=run_payload,
        )
        r2.raise_for_status()
    except (Exception, asyncio.CancelledError):
        _append_status_history(meta, "running", "failed", "create_task_rollback")
        meta[TASK_META_TASK_STATUS] = "failed"
        try:
            await client.patch(
                f"{api_url}/threads/{thread_id}",
                json={"metadata": meta},
            )
        except Exception as rollback_err:
            logger.warning("create_task rollback PATCH failed (original error will be raised): %s", rollback_err)
        try:
            await client.delete(f"{api_url}/threads/{thread_id}")
        except Exception as del_err:
            logger.warning("create_task rollback DELETE thread failed (thread may remain): %s", del_err)
        raise
    run_data = r2.json() or {}
    run_id = run_data.get("run_id") or (run_data.get("run") or {}).get("run_id") or ""

    return {"thread_id": thread_id, "run_id": run_id, "metadata": meta}


async def list_tasks(
    status: Optional[str] = None,
    role_id: Optional[str] = None,
    limit: int = 50,
    workspace_path: Optional[str] = None,
) -> list:
    """列出任务 = 搜索带 is_task 的 threads。limit 上限 100。workspace_path 可选，过滤同一工作区任务（空或未设置视为匹配任意）。"""
    limit = min(max(1, limit), 100)
    api_url = _get_api_url()
    params = {"limit": min(limit * 3, 300)}
    # 优先使用 threads/search，避免普通 threads 列表被非任务线程挤掉。
    metadata_filter = {TASK_META_IS_TASK: True}
    if status:
        metadata_filter[TASK_META_TASK_STATUS] = status
    data = None
    client = _get_http_client()
    try:
        r = await client.post(
            f"{api_url}/threads/search",
            json={"limit": limit, "metadata": metadata_filter},
        )
        r.raise_for_status()
        data = r.json()
    except Exception:
        try:
            r = await client.get(
                f"{api_url}/threads",
                params=params,
            )
            r.raise_for_status()
            data = r.json()
        except Exception:
            raise HTTPException(status_code=503, detail="任务列表不可用")
    if data is None:
        data = {}
    threads = data if isinstance(data, list) else data.get("threads", data.get("values", []))
    if not isinstance(threads, list):
        threads = []
    # 仅保留任务 thread，按 thread_id 去重后按更新时间倒序（新优先）
    seen_ids: set = set()
    out = []
    for t in threads:
        meta = t.get("metadata") or {}
        if meta.get(TASK_META_IS_TASK) is not True:
            continue
        if status and meta.get(TASK_META_TASK_STATUS) != status:
            continue
        normalized_role_id = str(role_id or "").strip()
        if normalized_role_id and str(meta.get("role_id") or "").strip() != normalized_role_id:
            continue
        wp = str(workspace_path or "").strip()
        if wp:
            task_wp = str(meta.get("workspace_path") or "").strip()
            if task_wp and task_wp != wp:
                continue
        tid = t.get("thread_id")
        if tid and tid in seen_ids:
            continue
        if tid:
            seen_ids.add(tid)
        out.append(t)

    # 仅当 search 无结果时再补一次 /threads，避免常态双请求
    if len(out) == 0:
        try:
            r_extra = await client.get(f"{api_url}/threads", params=params)
            if r_extra.status_code == 200:
                extra_data = r_extra.json() or {}
                extra_threads = (
                    extra_data
                    if isinstance(extra_data, list)
                    else extra_data.get("threads", extra_data.get("values", []))
                )
                if isinstance(extra_threads, list):
                    for t in extra_threads:
                        if not isinstance(t, dict):
                            continue
                        meta = t.get("metadata") or {}
                        if meta.get(TASK_META_IS_TASK) is not True:
                            continue
                        if status and meta.get(TASK_META_TASK_STATUS) != status:
                            continue
                        normalized_role_id = str(role_id or "").strip()
                        if normalized_role_id and str(meta.get("role_id") or "").strip() != normalized_role_id:
                            continue
                        wp = str(workspace_path or "").strip()
                        if wp:
                            task_wp = str(meta.get("workspace_path") or "").strip()
                            if task_wp and task_wp != wp:
                                continue
                        tid = t.get("thread_id")
                        if tid and tid in seen_ids:
                            continue
                        if tid:
                            seen_ids.add(tid)
                        out.append(t)
        except Exception as e:
            logger.debug("list_tasks extra threads supplement failed: %s", e)

    def _sort_key(item):
        ts = item.get("updated_at") or item.get("created_at") or ""
        return (ts or "") if isinstance(ts, str) else str(ts)
    out.sort(key=_sort_key, reverse=True)
    return out[:limit]


async def get_task(thread_id: str) -> dict:
    """获取任务详情 = 获取 thread + 最新 state。"""
    if not is_valid_thread_id_uuid(thread_id):
        raise TaskNotFoundError(f"thread_id={thread_id}")
    _validate_thread_id(thread_id)
    api_url = _get_api_url()
    client = _get_http_client()
    r = await client.get(f"{api_url}/threads/{thread_id}")
    if r.status_code == 404:
        raise TaskNotFoundError(f"thread_id={thread_id}")
    r.raise_for_status()
    thread = r.json()
    r2 = await client.get(f"{api_url}/threads/{thread_id}/state")
    if r2.status_code == 200:
        thread["state"] = r2.json()
    else:
        thread["state"] = {}
    return thread


async def update_task(thread_id: str, **updates: Any) -> dict:
    """更新任务 = 更新 thread metadata（仅允许白名单字段，task_status 受状态机约束）。"""
    if not is_valid_thread_id_uuid(thread_id):
        raise TaskNotFoundError(f"thread_id={thread_id}")
    _validate_thread_id(thread_id)
    allowed = {k: v for k, v in updates.items() if k in TASK_META_ALLOWED_UPDATE}
    if not allowed:
        api_url = _get_api_url()
        client = _get_http_client()
        r = await client.get(f"{api_url}/threads/{thread_id}")
        if r.status_code == 404:
            raise TaskNotFoundError(f"thread_id={thread_id}")
        r.raise_for_status()
        return r.json()
    api_url = _get_api_url()
    client = _get_http_client()
    r = await client.get(f"{api_url}/threads/{thread_id}")
    if r.status_code == 404:
        raise TaskNotFoundError(f"thread_id={thread_id}")
    r.raise_for_status()
    thread = r.json()
    meta = dict(thread.get("metadata") or {})
    if TASK_META_TASK_STATUS in allowed:
        current_status = str(meta.get(TASK_META_TASK_STATUS) or "").strip().lower()
        next_status = str(allowed[TASK_META_TASK_STATUS] or "").strip().lower()
        if next_status and not _can_transition_task_status(current_status, next_status):
            raise ValueError(
                f"不允许的状态迁移: {current_status} -> {next_status} (thread_id={thread_id})"
            )
        if current_status != next_status:
            _append_status_history(meta, current_status, next_status, "update_task")
    meta.update(allowed)
    r2 = await client.patch(
        f"{api_url}/threads/{thread_id}",
        json={"metadata": meta},
    )
    r2.raise_for_status()
    return r2.json()


async def cancel_task(thread_id: str) -> dict:
    """取消任务 = 更新 metadata 为 cancelled；如有活跃 run 可先 cancel。"""
    if not is_valid_thread_id_uuid(thread_id):
        raise TaskNotFoundError(f"thread_id={thread_id}")
    _validate_thread_id(thread_id)
    api_url = _get_api_url()
    client = _get_http_client()
    cancel_run_failed = False
    try:
        await client.post(f"{api_url}/threads/{thread_id}/runs/cancel")
    except Exception as e:
        logger.warning("取消 run 失败（thread_id=%s）: %s", thread_id, e)
        cancel_run_failed = True
    out = await update_task(thread_id, **{TASK_META_TASK_STATUS: "cancelled"})
    if cancel_run_failed:
        out["cancel_run_warning"] = "run 仍在运行，仅已将会话状态标为已取消"
    return out


def update_task_status_sync(
    thread_id: str,
    task_status: str,
    result_summary: Optional[dict] = None,
    error: Optional[str] = None,
) -> None:
    """同步更新任务状态（供 main_graph finally 块调用，避免阻塞事件循环）。

    当前实现为 GET /threads/{id} 后 PATCH /threads/{id}（两次 HTTP 往返）。
    非 UUID 的 thread_id 直接跳过，避免请求 LangGraph 触发 422。
    """
    if not is_valid_thread_id_uuid(thread_id):
        logger.debug("update_task_status_sync 跳过非 UUID thread_id: %s", (thread_id or "")[:50])
        return
    try:
        _validate_thread_id(thread_id)
    except ValueError:
        return
    api_url = _get_api_url()
    updates = {TASK_META_TASK_STATUS: task_status}
    if result_summary is not None:
        updates[TASK_META_RESULT_SUMMARY] = json.dumps(result_summary) if isinstance(result_summary, dict) else result_summary
    if error is not None:
        updates[TASK_META_ERROR] = error[:2000]
    try:
        client = _get_sync_http_client()
        r = client.get(f"{api_url}/threads/{thread_id}")
        if r.status_code != 200:
            return
        thread = r.json()
        meta = dict(thread.get("metadata") or {})
        if meta.get(TASK_META_IS_TASK) is not True:
            return
        current_status = str(meta.get(TASK_META_TASK_STATUS) or "").strip().lower()
        next_status = str(task_status or "").strip().lower()
        if not _can_transition_task_status(current_status, next_status):
            logger.debug(
                "ignore invalid task status transition: %s -> %s (thread_id=%s)",
                current_status,
                next_status,
                thread_id,
            )
            return
        if current_status != next_status:
            _append_status_history(meta, current_status, next_status, "main_graph_finalize")
        meta.update(updates)
        patch_r = client.patch(f"{api_url}/threads/{thread_id}", json={"metadata": meta})
        patch_r.raise_for_status()
    except Exception as e:
        logger.debug("update_task_status_sync failed (non-critical): %s", e)
