"""
任务看板巡检 - Agent 自主扫描可用任务并竞标

后台任务：定期拉取 status=available 的看板任务，对每条任务做自评估（evaluate_task_fit），
若适合则提交竞标（submit_bid）。可配合 LangGraph Cron 或 asyncio 后台任务启动。
"""

import asyncio
import logging
import json
import os
import threading
import uuid
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Callable, Awaitable

from backend.config.store_namespaces import (
    NS_BOARD_INVITES,
)
from backend.engine.tasks.store_access import get_task_store, board_ns_for_scope
from backend.utils.security import is_safe_callback_url as _is_safe_callback_url
from backend.engine.triggers.trigger_manager import TriggerManager
from backend.engine.organization.agent_spawner import get_agent_spawner
from backend.engine.organization import get_resource_pool, get_collective_learning
from backend.engine.prompts.agent_prompts import _sanitize_prompt_value

logger = logging.getLogger(__name__)

_watcher_task: Optional[asyncio.Task] = None
_scheduler_task: Optional[asyncio.Task] = None
_executor_tasks: Dict[str, asyncio.Task] = {}
_executor_task_agents: Dict[str, str] = {}
_a2a_http_client: Optional[Any] = None  # httpx.AsyncClient, lazy init
_asyncio_locks_guard = threading.Lock()
_a2a_client_lock: Optional[asyncio.Lock] = None
_executor_state_lock: Optional[asyncio.Lock] = None
_watcher_globals_lock = threading.Lock()
_stop_lock = threading.Lock()
_A2A_INVITE_MAX_RETRIES = 5
MAX_QUEUE_TIMEOUT_RETRIES = int(os.environ.get("MAX_QUEUE_TIMEOUT_RETRIES", "5"))


def _get_a2a_client_lock() -> asyncio.Lock:
    global _a2a_client_lock
    with _asyncio_locks_guard:
        if _a2a_client_lock is None:
            _a2a_client_lock = asyncio.Lock()
        return _a2a_client_lock


def _get_executor_state_lock() -> asyncio.Lock:
    global _executor_state_lock
    with _asyncio_locks_guard:
        if _executor_state_lock is None:
            _executor_state_lock = asyncio.Lock()
        return _executor_state_lock


_watcher_tasks: Dict[str, asyncio.Task] = {}
_watcher_assistant_id: str = ""
_watcher_role_ids: List[str] = []
_watcher_scope: str = "personal"
_watcher_interval = int(os.environ.get("TASK_WATCHER_INTERVAL", "30"))
_watcher_max_parallel_executions = int(os.environ.get("TASK_WATCHER_MAX_PARALLEL_EXECUTIONS", "2"))
_INVITE_OBSERVABILITY_DEFAULTS: Dict[str, Any] = {
    "scan_search_calls": 0,
    "scan_fallback_calls": 0,
    "scan_search_rows": 0,
    "scan_fallback_rows": 0,
    "scan_search_errors": 0,
    "rows_seen": 0,
    "processable_rows": 0,
    "ignored": 0,
    "skipped": 0,
    "invalid": 0,
    "bid_submitted": 0,
    "bid_failed": 0,
    "loop_errors": 0,
    "last_scan_path": "",
    "last_scan_at": "",
    "last_error": "",
}
_invite_observability: Dict[str, Any] = dict(_INVITE_OBSERVABILITY_DEFAULTS)
_schedule_poll_seconds = int(os.environ.get("AUTONOMOUS_SCHEDULE_POLL_SECONDS", "60"))
_claimed_timeout_seconds = int(os.environ.get("TASK_CLAIMED_TIMEOUT_SECONDS", "180"))
_running_timeout_seconds = int(os.environ.get("TASK_RUNNING_TIMEOUT_SECONDS", "1800"))
_spawn_trigger_running_tasks = int(os.environ.get("TASK_SPAWN_TRIGGER_RUNNING_TASKS", "3"))
_spawn_cooldown_seconds = int(os.environ.get("TASK_SPAWN_COOLDOWN_SECONDS", "600"))
_spawn_last_ts: Dict[str, float] = {}
_spawn_locks: Dict[str, asyncio.Lock] = {}
_spawn_locks_guard = threading.Lock()
_agent_spawner = get_agent_spawner()


def _get_spawn_lock(parent: str) -> asyncio.Lock:
    with _spawn_locks_guard:
        if parent not in _spawn_locks:
            _spawn_locks[parent] = asyncio.Lock()
        return _spawn_locks[parent]


def is_task_execution_reliability_v2_enabled() -> bool:
    return str(os.getenv("TASK_EXECUTION_RELIABILITY_V2", "false")).strip().lower() in {"1", "true", "yes", "on"}


def _bump_invite_observability(key: str, delta: int = 1) -> None:
    try:
        _invite_observability[key] = int(_invite_observability.get(key, 0) or 0) + int(delta or 0)
    except Exception:
        pass


def _set_invite_observability(key: str, value: Any) -> None:
    try:
        _invite_observability[key] = value
    except Exception:
        pass


def _snapshot_invite_observability() -> Dict[str, Any]:
    try:
        return dict(_invite_observability)
    except Exception:
        return {}


def reset_invites_observability() -> Dict[str, Any]:
    """重置 watcher invites 观测计数，便于分批灰度对比。"""
    _invite_observability.clear()
    _invite_observability.update(dict(_INVITE_OBSERVABILITY_DEFAULTS))
    _invite_observability["last_scan_at"] = datetime.now(timezone.utc).isoformat()
    _invite_observability["last_scan_path"] = "reset"
    return _snapshot_invite_observability()


def _log_dispatch_decision(stage: str, task_id: str, scope: str, **extra: Any) -> None:
    payload: Dict[str, Any] = {
        "stage": str(stage or ""),
        "task_id": str(task_id or ""),
        "scope": str(scope or "personal"),
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    payload.update({str(k): v for k, v in (extra or {}).items()})
    try:
        logger.info("[DispatchDecision] %s", json.dumps(payload, ensure_ascii=False, sort_keys=True))
    except Exception:
        logger.info("[DispatchDecision] stage=%s task_id=%s scope=%s", stage, task_id, scope)


def _resource_gate(role_id: str, scope: str) -> Dict[str, Any]:
    try:
        quota = get_resource_pool().get_quota(role_id)
        slots = max(1, int(getattr(quota, "cpu_slots", 1) or 1))
        running = int(_get_agent_load(role_id, scope=scope).get("running_tasks", 0) or 0)
        if running >= slots:
            return {"ok": False, "reason": "cpu_slots_exceeded", "running": running, "slots": slots}
        return {"ok": True, "running": running, "slots": slots}
    except Exception:
        return {"ok": True, "running": 0, "slots": 1}


def _adjusted_min_confidence(base_min: float, agent_id: str, task: Dict[str, Any]) -> float:
    """按组织学习信号动态调整竞标阈值。"""
    threshold = float(base_min or 0.6)
    try:
        ttype = str(task.get("task_type") or task.get("skill_profile") or "").strip()
        score = float(get_collective_learning().agent_recent_score(agent_id, task_type=ttype, limit=40).get("score", 0.0))
        if score < 0:
            threshold += min(0.15, abs(score) * 0.12)
        elif score > 0:
            threshold -= min(0.05, score * 0.05)
    except Exception:
        pass
    return max(0.35, min(0.9, threshold))

_TERMINAL_STATES = {"completed", "failed", "cancelled"}
_ALLOWED_TRANSITIONS = {
    "": {"available", "claimed", "running", "failed", "completed"},
    "available": {"bidding", "claimed", "running", "failed", "cancelled", "awaiting_plan_confirm", "blocked"},
    "bidding": {"claimed", "available", "failed", "cancelled"},
    "claimed": {"available", "running", "failed", "cancelled", "blocked", "awaiting_plan_confirm"},
    "running": {"completed", "failed", "paused", "cancelled", "blocked", "waiting_human", "awaiting_plan_confirm"},
    "awaiting_plan_confirm": {"running", "available", "failed", "cancelled", "blocked"},
    "blocked": {"running", "available", "failed", "cancelled"},
    "waiting_human": {"running", "paused", "failed", "cancelled"},
    "paused": {"running", "failed", "cancelled"},
    "completed": set(),
    "failed": set(),
    "cancelled": set(),
}


def _record_daily_autonomous_task_usage(scope: str, task_type: str) -> None:
    try:
        from backend.config.store_namespaces import NS_BILLING_USAGE

        store = _get_store()
        if store is None:
            return
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        key = f"autonomous_tasks:{day}"
        out = store.get(NS_BILLING_USAGE, key)
        raw = getattr(out, "value", out) if out else {}
        val = dict(raw) if isinstance(raw, dict) else {}
        val["date"] = day
        val["scope"] = scope or "personal"
        val["task_count"] = int(val.get("task_count", 0) or 0) + 1
        if task_type:
            breakdown = val.get("task_type_breakdown")
            if not isinstance(breakdown, dict):
                breakdown = {}
            breakdown[str(task_type)] = int(breakdown.get(str(task_type), 0) or 0) + 1
            val["task_type_breakdown"] = breakdown
        val["updated_at"] = datetime.now(timezone.utc).isoformat()
        store.put(NS_BILLING_USAGE, key, val)
    except Exception as e:
        logger.debug("记录自治任务计费使用失败: %s", e)


def _is_valid_transition(current_status: str, next_status: str) -> bool:
    current = (current_status or "").strip().lower()
    target = (next_status or "").strip().lower()
    if current == target:
        return True
    if current in _TERMINAL_STATES:
        return False
    return target in _ALLOWED_TRANSITIONS.get(current, set())


async def _register_executor_task(
    task_id: str,
    agent_id: str,
    task_factory: Callable[[], Awaitable[Any]],
) -> bool:
    async with _get_executor_state_lock():
        running_task = _executor_tasks.get(task_id)
        if running_task is not None and not running_task.done():
            return False
        _executor_task_agents[task_id] = agent_id
        _executor_tasks[task_id] = asyncio.create_task(task_factory())
        return True


async def _running_for_agent(agent_id: str) -> int:
    async with _get_executor_state_lock():
        return sum(
            1
            for t_id, t in _executor_tasks.items()
            if not t.done() and _executor_task_agents.get(t_id) == agent_id
        )


async def _unregister_executor_task(task_id: str) -> None:
    async with _get_executor_state_lock():
        _executor_task_agents.pop(task_id, None)
        _executor_tasks.pop(task_id, None)


def _get_role_config(role_id: str) -> Optional[Dict[str, Any]]:
    try:
        from backend.engine.roles import get_role
        return get_role(role_id)
    except Exception:
        return None


def _get_role_skills(role_id: str) -> List[str]:
    role = _get_role_config(role_id)
    if not role:
        return []
    skills = []
    sp = role.get("skill_profile")
    if isinstance(sp, str) and sp.strip():
        skills.append(sp.strip())
    for cap in role.get("capabilities") or []:
        if isinstance(cap, dict) and cap.get("skill"):
            skills.append(str(cap["skill"]).strip())
    return skills


def _get_agent_load(role_id: str, scope: str = "personal") -> Dict[str, Any]:
    """当前 Agent（角色）的负载，如正在执行的任务数。简化实现。"""
    try:
        from backend.engine.tasks.task_bidding import list_board_tasks
        tasks = list_board_tasks(scope=scope, status="running", limit=500)
        running = sum(1 for t in tasks if t.get("claimed_by") == role_id)
        return {"running_tasks": running}
    except Exception:
        return {"running_tasks": 0}


async def _maybe_request_spawn(parent_role_id: str, reason: str, task_id: Optional[str] = None) -> Optional[str]:
    """高负载/低匹配时申请孵化子 Agent（组织化预留）。按 parent 细粒度锁保护冷却检查防竞态。"""
    parent = str(parent_role_id or "").strip() or "assistant"
    async with _get_spawn_lock(parent):
        now = time.time()
        last = float(_spawn_last_ts.get(parent, 0.0))
        if now - last < _spawn_cooldown_seconds:
            return None
        child_role = f"{parent}_worker"
        child_id = _agent_spawner.request_spawn(
            parent_agent_id=parent,
            role=child_role,
            reason=reason[:300],
            task_id=(str(task_id).strip() if task_id else None),
        )
        _spawn_last_ts[parent] = now
    logger.info("已申请孵化子 Agent: parent=%s child=%s reason=%s", parent, child_id, reason)
    return child_id


def _resolve_dispatch_roles(preferred_role_id: str = "assistant") -> List[str]:
    """解析一次性分发时可用的候选角色列表。"""
    roles: List[str] = []
    pref = str(preferred_role_id or "").strip()
    if pref:
        roles.append(pref)
    with _watcher_globals_lock:
        _role_ids = list(_watcher_role_ids)
        _assistant_id = _watcher_assistant_id
    if _role_ids:
        roles.extend([str(r).strip() for r in _role_ids if str(r).strip()])
    if _assistant_id:
        roles.append(str(_assistant_id).strip())
    try:
        from backend.engine.roles import list_roles

        all_roles = [str((r or {}).get("id") or "").strip() for r in list_roles() if isinstance(r, dict)]
        all_roles = [r for r in all_roles if r]
        if pref and pref in all_roles:
            roles.insert(0, pref)
        roles.extend(all_roles)
    except Exception:
        pass
    # 兜底角色：避免角色发现异常时分发直接失效
    if "assistant" not in roles:
        roles.append("assistant")
    seen = set()
    deduped: List[str] = []
    for r in roles:
        if r and r not in seen:
            seen.add(r)
            deduped.append(r)
    return deduped


def _load_board_task(scope: str, task_id: str) -> Optional[Dict[str, Any]]:
    store = _get_store()
    if store is None:
        return None
    out = store.get(_board_ns_for_scope(scope), task_id)
    if not out:
        return None
    v = getattr(out, "value", out) if not isinstance(out, dict) else out
    val = dict(v) if isinstance(v, dict) else {}
    return {"id": task_id, **val}


def _claim_task_to_role(scope: str, task_id: str, role_id: str) -> bool:
    store = _get_store()
    if store is None:
        return False
    out = store.get(_board_ns_for_scope(scope), task_id)
    if not out:
        return False
    v = getattr(out, "value", out) if not isinstance(out, dict) else out
    val = dict(v) if isinstance(v, dict) else {}
    status = str(val.get("status") or "").strip().lower()
    if status in {"running", "completed", "failed", "cancelled", "paused", "waiting_human", "awaiting_plan_confirm", "blocked"}:
        return False
    if str(val.get("thread_id") or "").strip():
        return False
    try:
        from backend.engine.tasks.task_bidding import project_board_task_status

        if project_board_task_status(
            task_id=task_id,
            status="claimed",
            scope=scope,
            thread_id=str(val.get("thread_id") or "") or None,
            progress=int(val.get("progress", 0) or 0),
            progress_message=str(val.get("progress_message") or ""),
            dispatch_state=str(val.get("dispatch_state") or "") or None,
            claimed_by=role_id,
            source="task_watcher",
            only_when_status_in={"available", "bidding", "pending"},
        ):
            return True
    except Exception:
        pass
    logger.warning("projection write failed: skip direct claim fallback task_id=%s scope=%s", task_id, scope)
    return False


async def dispatch_task_once(
    task_id: str,
    scope: str = "personal",
    min_confidence: float = 0.6,
    preferred_role_id: str = "",
) -> Dict[str, Any]:
    """
    一次性即时分发：评估 -> 竞标 -> 自动认领 -> 启动执行。
    用于创建任务后立即触发，避免等待 watcher 轮询。
    """
    from backend.engine.tasks.task_bidding import evaluate_task_fit, submit_bid, resolve_bids

    task = _load_board_task(scope, task_id)
    if not task:
        _log_dispatch_decision("dispatch_not_found", task_id, scope)
        return {"ok": False, "state": "not_found", "error": "任务不存在"}
    status = str(task.get("status") or "").strip().lower()
    if status == "waiting_human":
        _log_dispatch_decision("dispatch_waiting_human", task_id, scope, status=status)
        return {"ok": True, "state": "waiting_human"}
    if status == "awaiting_plan_confirm":
        _log_dispatch_decision("dispatch_awaiting_plan_confirm", task_id, scope, status=status)
        return {"ok": True, "state": "awaiting_plan_confirm"}
    if status == "blocked":
        _log_dispatch_decision("dispatch_blocked", task_id, scope, status=status)
        return {"ok": True, "state": "blocked"}
    if status in {"running", "completed", "failed", "cancelled", "paused"}:
        _log_dispatch_decision("dispatch_skip_terminal", task_id, scope, status=status)
        return {"ok": True, "state": "already_terminal_or_running", "status": status}
    if str(task.get("thread_id") or "").strip():
        _log_dispatch_decision("dispatch_already_has_thread", task_id, scope, thread_id=str(task.get("thread_id") or ""))
        return {"ok": True, "state": "already_has_thread", "thread_id": str(task.get("thread_id") or "")}

    # 已被认领但未执行：直接启动
    claimed_by = str(task.get("claimed_by") or "").strip()
    if claimed_by and status == "claimed":
        _log_dispatch_decision("dispatch_claimed_direct_start", task_id, scope, claimed_by=claimed_by)
        started = await _register_executor_task(
            task_id,
            claimed_by,
            lambda: _execute_claimed_task(task, assistant_id=claimed_by, scope=scope),
        )
        if not started:
            _log_dispatch_decision("dispatch_claimed_already_running", task_id, scope, claimed_by=claimed_by)
            return {"ok": True, "state": "already_running", "claimed_by": claimed_by}
        _log_dispatch_decision("dispatch_claimed_execution_started", task_id, scope, claimed_by=claimed_by)
        return {"ok": True, "state": "execution_started", "claimed_by": claimed_by}

    resolved_preferred = str(preferred_role_id or task.get("preferred_role_id") or task.get("role_id") or "").strip()
    role_ids = _resolve_dispatch_roles(preferred_role_id=resolved_preferred or "assistant")
    if not role_ids:
        _log_dispatch_decision("dispatch_no_roles", task_id, scope, preferred_role_id=resolved_preferred or "assistant")
        await _maybe_request_spawn(
            resolved_preferred or "assistant",
            "dispatch_task_once no available roles",
            task_id=task_id,
        )
        return {"ok": False, "state": "no_roles", "error": "无可用角色"}
    eligible_roles: List[str] = []
    for rid in role_ids:
        gate = _resource_gate(rid, scope=scope)
        if gate.get("ok"):
            eligible_roles.append(rid)
        else:
            _log_dispatch_decision(
                "dispatch_role_resource_rejected",
                task_id,
                scope,
                role_id=rid,
                reason=str(gate.get("reason") or ""),
                running=int(gate.get("running", 0) or 0),
                slots=int(gate.get("slots", 1) or 1),
            )
    if not eligible_roles:
        await _maybe_request_spawn(
            resolved_preferred or "assistant",
            "dispatch_task_once all roles resource limited",
            task_id=task_id,
        )
        return {"ok": False, "state": "resource_limited", "error": "可用角色资源不足"}
    role_ids = eligible_roles

    required_skills = task.get("required_skills") if isinstance(task.get("required_skills"), list) else []
    existing_bids = [b for b in (task.get("bids") or []) if isinstance(b, dict)]
    existing_agents = {str(b.get("agent_id") or "").strip() for b in existing_bids if str(b.get("agent_id") or "").strip()}
    _log_dispatch_decision(
        "dispatch_bidding_started",
        task_id,
        scope,
        candidate_roles=role_ids,
        required_skills=required_skills,
        existing_assignees=sorted(list(existing_agents)),
        min_confidence=float(min_confidence),
    )
    for role_id in role_ids:
        if role_id in existing_agents:
            continue
        try:
            fit = await evaluate_task_fit(
                task_subject=str(task.get("subject") or ""),
                task_description=str(task.get("description") or ""),
                task_tags=required_skills,
                agent_profile=_get_role_config(role_id) or {},
                agent_skills=_get_role_skills(role_id),
                agent_load=_get_agent_load(role_id, scope=scope),
            )
            if fit.get("can_handle") and float(fit.get("confidence", 0)) >= min_confidence:
                await submit_bid(task_id, role_id, fit, scope=scope)
                _log_dispatch_decision(
                    "dispatch_bid_submitted",
                    task_id,
                    scope,
                    role_id=role_id,
                    confidence=float(fit.get("confidence", 0) or 0),
                    skill_match=float(fit.get("skill_match", 0) or 0),
                )
        except Exception as e:
            logger.debug("dispatch_task_once 竞标失败 task_id=%s role=%s: %s", task_id, role_id, e)
            _log_dispatch_decision("dispatch_bid_failed", task_id, scope, role_id=role_id, error=str(e))

    resolved = await resolve_bids(task_id, strategy="fair_weighted", scope=scope)
    _log_dispatch_decision(
        "dispatch_resolve_result",
        task_id,
        scope,
        ok=bool(resolved.get("ok")),
        claimed_by=str(resolved.get("claimed_by") or ""),
        error=str(resolved.get("error") or ""),
    )
    if not resolved.get("ok"):
        await _maybe_request_spawn(
            resolved_preferred or "assistant",
            f"dispatch_task_once unresolved bids task={task_id} required_skills={required_skills}",
            task_id=task_id,
        )
        # 无有效竞标时回退到默认角色认领，避免“创建后完全无反应”
        fallback_role = role_ids[0] if role_ids else ""
        async with _get_executor_state_lock():
            if fallback_role and _claim_task_to_role(scope=scope, task_id=task_id, role_id=fallback_role):
                _log_dispatch_decision("dispatch_fallback_claimed", task_id, scope, fallback_role=fallback_role)
                resolved = {"ok": True, "claimed_by": fallback_role}
            else:
                _log_dispatch_decision("dispatch_unresolved_no_fallback", task_id, scope, error=str(resolved.get("error") or "无竞标"))
                return {"ok": False, "state": "no_bid_or_unresolved", "error": str(resolved.get("error") or "无竞标")}

    claimed_by = str(resolved.get("claimed_by") or "").strip()
    if not claimed_by:
        _log_dispatch_decision("dispatch_invalid_claim", task_id, scope)
        return {"ok": False, "state": "invalid_claim", "error": "认领结果无角色"}

    refreshed = _load_board_task(scope, task_id) or task
    refreshed_status = str(refreshed.get("status") or "").strip().lower()
    refreshed_thread = str(refreshed.get("thread_id") or "").strip()
    if refreshed_thread or refreshed_status == "running":
        _log_dispatch_decision(
            "dispatch_already_running_after_refresh",
            task_id,
            scope,
            claimed_by=claimed_by,
            thread_id=refreshed_thread,
            status=refreshed_status,
        )
        return {"ok": True, "state": "already_running", "claimed_by": claimed_by, "thread_id": refreshed_thread}
    started = await _register_executor_task(
        task_id,
        claimed_by,
        lambda: _execute_claimed_task(refreshed, assistant_id=claimed_by, scope=scope),
    )
    if not started:
        _log_dispatch_decision("dispatch_register_skipped_running", task_id, scope, claimed_by=claimed_by, thread_id=refreshed_thread)
        return {"ok": True, "state": "already_running", "claimed_by": claimed_by, "thread_id": refreshed_thread}
    _log_dispatch_decision("dispatch_execution_started", task_id, scope, claimed_by=claimed_by)
    return {"ok": True, "state": "execution_started", "claimed_by": claimed_by}


# 无任务时轮询间隔退避：30 -> 60 -> 120 -> 300（秒），有任务时恢复 30
WATCHER_INTERVALS = (30, 60, 120, 300)
WATCHER_INTERVAL_MIN, WATCHER_INTERVAL_MAX = 30, 300


def _get_project_root() -> Path:
    try:
        from backend.tools.base.paths import get_project_root
        return get_project_root()
    except Exception:
        return Path(__file__).resolve().parents[3]


def _scheduler_state_path() -> Path:
    return _get_project_root() / "data" / "autonomous_task_state.json"


def _load_scheduler_state() -> Dict[str, Any]:
    p = _scheduler_state_path()
    if not p.exists():
        return {"tasks": {}, "recent_runs": []}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("tasks", {})
            data.setdefault("recent_runs", [])
            return data
    except Exception:
        pass
    return {"tasks": {}, "recent_runs": []}


def _save_scheduler_state(state: Dict[str, Any]) -> None:
    p = _scheduler_state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, p)


def _load_gap_report(refresh: bool = False) -> Dict[str, Any]:
    if refresh:
        try:
            from backend.engine.tasks.gap_detector import detect_knowledge_gaps

            data = detect_knowledge_gaps(project_root=_get_project_root())
            if isinstance(data, dict):
                return data
        except Exception as e:
            logger.debug("gap detector refresh failed, fallback to cache: %s", e)
    path = _get_project_root() / "knowledge_base" / "learned" / "audits" / "gap_report.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


async def _run_scheduled_autonomous_tasks() -> None:
    """按 trigger_manager 统一调度（当前支持 cron daily/weekly）。"""
    trigger_mgr = TriggerManager(_get_project_root() / "backend" / "config" / "autonomous_tasks.json")
    while True:
        try:
            await asyncio.sleep(max(15, _schedule_poll_seconds))
            state = await asyncio.to_thread(_load_scheduler_state)
            tasks_state = state.setdefault("tasks", {})
            recent_runs = state.setdefault("recent_runs", [])
            now = datetime.now(timezone.utc).astimezone()
            changed = False
            gap_report = await asyncio.to_thread(_load_gap_report)
            for trigger in trigger_mgr.due_tasks(now):
                item = trigger.raw
                task_key = str(item.get("id") or item.get("subject") or "")
                if not task_key:
                    continue
                slot = trigger.slot
                rec = tasks_state.get(task_key) if isinstance(tasks_state.get(task_key), dict) else {}
                if rec.get("last_slot") == slot:
                    continue
                if bool(item.get("startup_once")) and rec.get("startup_done"):
                    continue
                subject = str(item.get("subject", "") or "").strip() or task_key
                description = str(item.get("description", "") or "").strip() or subject
                task_type = str(item.get("task_type", "") or "").strip()
                role_id = str(item.get("role_id", "") or "").strip()
                auto_assign = bool(item.get("auto_assign", False))
                required_skills = item.get("required_skills") if isinstance(item.get("required_skills"), list) else None
                created = await _create_board_autonomous_task(
                    scope="personal",
                    subject=subject,
                    description=description,
                    task_type=task_type,
                    required_skills=required_skills,
                    auto_assign=auto_assign,
                    preferred_role_id=role_id,
                )
                tasks_state[task_key] = {
                    "last_slot": slot,
                    "last_run_at": datetime.now(timezone.utc).isoformat(),
                    "startup_done": bool(item.get("startup_once")),
                }
                if isinstance(recent_runs, list):
                    recent_runs.append(
                        {
                            "task_id": task_key,
                            "subject": subject,
                            "slot": slot,
                            "triggered_at": datetime.now(timezone.utc).isoformat(),
                            "board_task_id": str((created or {}).get("task_id") or ""),
                            "dispatch_state": str((created or {}).get("dispatch_state") or ""),
                            # 兼容 app.py 既有 autonomous/runs 展示结构
                            "thread_id": str((created or {}).get("thread_id") or ""),
                            "run_id": str((created or {}).get("run_id") or str((created or {}).get("task_id") or "")),
                        }
                    )
                    # 仅保留最近 30 条，避免状态文件无限增长
                    state["recent_runs"] = recent_runs[-30:]
                changed = True
                logger.info("调度任务已触发: %s (%s)", task_key, slot)
                # 若是缺口分析相关任务，读取 gap_report 自动创建补齐任务
                if task_type in {"kb_gap_check", "kb-gap-analysis", "kb_gap_analysis"}:
                    gap_report = await asyncio.to_thread(_load_gap_report, True)
                if task_type in {"kb_gap_check", "kb-gap-analysis", "kb_gap_analysis"} and isinstance(gap_report, dict):
                    for gap in (gap_report.get("gaps") or [])[:20]:
                        if not isinstance(gap, dict):
                            continue
                        gtype = str(gap.get("type") or gap.get("gap_type") or "gap")
                        et = str(gap.get("entity_type") or gap.get("target") or gap.get("name") or "unknown")
                        priority = str(gap.get("priority") or "").strip().lower()
                        gkey = f"gap_followup:{gtype}:{et}"
                        grecord = tasks_state.get(gkey) if isinstance(tasks_state.get(gkey), dict) else {}
                        if grecord.get("last_slot") == slot:
                            continue
                        followup_subject = f"补齐知识缺口 {gtype}:{et}"
                        followup_desc = json.dumps(gap, ensure_ascii=False)
                        required = ["kb-web-harvest", "kb-entity-extract", "kb-quality-audit"]
                        # 高优先级缺口优先修复本体映射，避免后续抽取继续产生脏数据。
                        if priority == "high":
                            required = ["kb-ontology-import"] + required
                        created_gap = await _create_board_autonomous_task(
                            scope="personal",
                            subject=followup_subject,
                            description=followup_desc,
                            task_type="kb_gap_followup",
                            required_skills=required,
                            auto_assign=True,
                            preferred_role_id="default",
                        )
                        tasks_state[gkey] = {
                            "last_slot": slot,
                            "last_run_at": datetime.now(timezone.utc).isoformat(),
                            "parent": task_key,
                        }
                        if isinstance(recent_runs, list):
                            recent_runs.append(
                                {
                                    "task_id": gkey,
                                    "subject": followup_subject,
                                    "slot": slot,
                                    "triggered_at": datetime.now(timezone.utc).isoformat(),
                                    "board_task_id": str((created_gap or {}).get("task_id") or ""),
                                    "dispatch_state": str((created_gap or {}).get("dispatch_state") or ""),
                                }
                            )
                        changed = True
            if changed:
                await asyncio.to_thread(_save_scheduler_state, state)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.exception("autonomous scheduler loop error: %s", e)
            await asyncio.sleep(min(60, max(15, _schedule_poll_seconds)))


def _get_store():
    return get_task_store()


def _board_ns_for_scope(scope: str) -> tuple:
    return board_ns_for_scope(scope)


def _invites_ns() -> tuple:
    return NS_BOARD_INVITES


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


def _list_invites_items(store: Any, limit: int = 30) -> List[Dict[str, Any]]:
    """
    批量读取 invites，优先 search（单次批量），回退 list+get。
    返回格式统一为 [{"id": invite_id, ...invite_dict}]。
    """
    max_limit = max(1, int(limit or 1))
    ns = _invites_ns()

    # Fast path
    if hasattr(store, "search"):
        _bump_invite_observability("scan_search_calls", 1)
        try:
            rows: List[Dict[str, Any]] = []
            for item in store.search(ns, limit=max_limit):
                invite_id = _extract_store_key(item)
                invite_val = _extract_store_value(item)
                if invite_id is None or not isinstance(invite_val, dict):
                    continue
                rows.append({"id": str(invite_id), **dict(invite_val)})
            _bump_invite_observability("scan_search_rows", len(rows))
            if rows:
                _set_invite_observability("last_scan_path", "search")
                _set_invite_observability("last_scan_at", datetime.now(timezone.utc).isoformat())
                return rows
        except Exception as e:
            _bump_invite_observability("scan_search_errors", 1)
            _set_invite_observability("last_error", str(e))

    # Fallback path (仅在 store 同时具备 list/get 能力时启用)
    if not (hasattr(store, "list") and hasattr(store, "get")):
        _set_invite_observability("last_scan_path", "search_only")
        _set_invite_observability("last_scan_at", datetime.now(timezone.utc).isoformat())
        return []

    _bump_invite_observability("scan_fallback_calls", 1)
    rows = []
    for invite_id in list(store.list(ns))[:max_limit]:
        out = store.get(ns, invite_id)
        if not out:
            continue
        invite_val = _extract_store_value(out)
        if not isinstance(invite_val, dict):
            continue
        rows.append({"id": str(invite_id), **dict(invite_val)})
    _bump_invite_observability("scan_fallback_rows", len(rows))
    _set_invite_observability("last_scan_path", "list_get")
    _set_invite_observability("last_scan_at", datetime.now(timezone.utc).isoformat())
    return rows


def _set_task_running(scope: str, task_id: str, thread_id: str) -> None:
    store = _get_store()
    if store is None:
        return
    out = store.get(_board_ns_for_scope(scope), task_id)
    if not out:
        return
    v = getattr(out, "value", out) if not isinstance(out, dict) else out
    val = dict(v) if isinstance(v, dict) else {}
    current_status = str(val.get("status") or "").strip().lower()
    if not _is_valid_transition(current_status, "running"):
        logger.debug("拒绝非法状态转换: %s -> running (task_id=%s)", current_status, task_id)
        return
    val["status"] = "running"
    val["thread_id"] = thread_id
    val["progress"] = max(1, int(val.get("progress", 0) or 0))
    val["progress_message"] = "autonomous_watcher_started"
    val["dispatch_state"] = "running"
    try:
        from backend.engine.tasks.task_bidding import project_board_task_status

        if project_board_task_status(
            task_id=task_id,
            status="running",
            scope=scope,
            thread_id=thread_id,
            progress=int(val.get("progress", 1) or 1),
            progress_message="autonomous_watcher_started",
            dispatch_state="running",
            source="task_watcher",
        ):
            return
    except Exception:
        pass
    logger.warning("projection write failed: fallback store put task_id=%s scope=%s", task_id, scope)
    val["updated_at"] = datetime.now(timezone.utc).isoformat()
    try:
        store.put(_board_ns_for_scope(scope), task_id, val)
    except Exception as e:
        logger.exception("fallback store put failed task_id=%s: %s", task_id, e)


def _set_task_failed(
    scope: str,
    task_id: str,
    err: str,
    thread_id: str,
    dispatch_state: Optional[str] = None,
) -> None:
    store = _get_store()
    if store is None:
        return
    out = store.get(_board_ns_for_scope(scope), task_id)
    if not out:
        return
    v = getattr(out, "value", out) if not isinstance(out, dict) else out
    val = dict(v) if isinstance(v, dict) else {}
    current_status = str(val.get("status") or "").strip().lower()
    if not _is_valid_transition(current_status, "failed"):
        logger.debug("拒绝非法状态转换: %s -> failed (task_id=%s)", current_status, task_id)
        return
    val["status"] = "failed"
    val["thread_id"] = thread_id
    val["result"] = (err or "")[:2000]
    val["progress"] = int(val.get("progress", 0) or 0)
    val["progress_message"] = "autonomous_watcher_failed"
    if dispatch_state:
        val["dispatch_state"] = str(dispatch_state)
        if dispatch_state == "execution_timeout":
            val["execution_timeout_count"] = int(val.get("execution_timeout_count", 0) or 0) + 1
    try:
        from backend.engine.tasks.task_bidding import project_board_task_status

        if project_board_task_status(
            task_id=task_id,
            status="failed",
            scope=scope,
            thread_id=thread_id,
            result=val.get("result") or "",
            progress=int(val.get("progress", 0) or 0),
            progress_message=str(val.get("progress_message") or "autonomous_watcher_failed"),
            dispatch_state=str(val.get("dispatch_state") or "") or None,
            source="task_watcher",
        ):
            return
    except Exception:
        pass
    logger.warning("projection write failed: fallback store put task_id=%s scope=%s", task_id, scope)
    val["updated_at"] = datetime.now(timezone.utc).isoformat()
    try:
        store.put(_board_ns_for_scope(scope), task_id, val)
    except Exception as e:
        logger.exception("fallback store put failed task_id=%s: %s", task_id, e)


def _set_task_completed(scope: str, task_id: str, result: str, thread_id: str) -> None:
    store = _get_store()
    if store is None:
        return
    out = store.get(_board_ns_for_scope(scope), task_id)
    if not out:
        return
    v = getattr(out, "value", out) if not isinstance(out, dict) else out
    val = dict(v) if isinstance(v, dict) else {}
    current_status = str(val.get("status") or "").strip().lower()
    if not _is_valid_transition(current_status, "completed"):
        logger.debug("拒绝非法状态转换: %s -> completed (task_id=%s)", current_status, task_id)
        return
    val["status"] = "completed"
    val["thread_id"] = thread_id
    if result:
        val["result"] = result[:5000]
    val["progress"] = 100
    val["progress_message"] = "autonomous_watcher_completed"
    try:
        from backend.engine.tasks.task_bidding import project_board_task_status

        if project_board_task_status(
            task_id=task_id,
            status="completed",
            scope=scope,
            thread_id=thread_id,
            result=val.get("result") or "",
            progress=100,
            progress_message="autonomous_watcher_completed",
            source="task_watcher",
        ):
            return
    except Exception:
        pass
    logger.warning("projection write failed: fallback store put task_id=%s scope=%s", task_id, scope)
    val["updated_at"] = datetime.now(timezone.utc).isoformat()
    try:
        store.put(_board_ns_for_scope(scope), task_id, val)
    except Exception as e:
        logger.exception("fallback store put failed task_id=%s: %s", task_id, e)


def _get_task_status(scope: str, task_id: str) -> str:
    store = _get_store()
    if store is None:
        return ""
    out = store.get(_board_ns_for_scope(scope), task_id)
    if not out:
        return ""
    v = getattr(out, "value", out) if not isinstance(out, dict) else out
    val = dict(v) if isinstance(v, dict) else {}
    return str(val.get("status") or "")


def _parse_iso_ts(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc)
        raw = str(value).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _parse_schedule(schedule: str) -> Dict[str, Any]:
    """
    兼容旧测试/调用方的轻量调度解析：
    - daily HH:MM
    - weekly <weekday> HH:MM
    """
    raw = str(schedule or "").strip()
    parts = raw.split()
    if len(parts) == 2 and parts[0].lower() == "daily":
        return {"kind": "daily", "time": parts[1]}
    if len(parts) == 3 and parts[0].lower() == "weekly":
        weekday_map = {
            "monday": 0,
            "tuesday": 1,
            "wednesday": 2,
            "thursday": 3,
            "friday": 4,
            "saturday": 5,
            "sunday": 6,
        }
        weekday = weekday_map.get(parts[1].strip().lower())
        if weekday is not None:
            return {"kind": "weekly", "weekday": weekday, "time": parts[2]}
    return {}


def _is_due(parsed: Dict[str, Any], now: datetime) -> bool:
    """兼容旧测试的到期判定。"""
    if not isinstance(parsed, dict):
        return False
    kind = str(parsed.get("kind") or "").strip().lower()
    t = str(parsed.get("time") or "").strip()
    try:
        hh, mm = [int(x) for x in t.split(":", 1)]
    except Exception:
        return False
    if kind == "daily":
        return (now.hour, now.minute) >= (hh, mm)
    if kind == "weekly":
        try:
            weekday = int(parsed.get("weekday", -1))
        except Exception:
            return False
        return now.weekday() == weekday and (now.hour, now.minute) >= (hh, mm)
    return False


def _fair_dispatch_rank(task: Dict[str, Any]) -> float:
    """可分发任务排序分数（分数越高越优先）。"""
    now = datetime.now(timezone.utc)
    priority = max(1, min(5, int(task.get("priority", 3) or 3)))
    enqueued = _parse_iso_ts(task.get("request_enqueued_at")) or _parse_iso_ts(task.get("created_at")) or now
    waiting_minutes = max(0.0, (now - enqueued).total_seconds() / 60.0)
    waiting_score = min(2.0, waiting_minutes / 30.0)
    retry_count = max(0, int(task.get("retry_count", 0) or 0))
    retry_penalty = min(1.5, retry_count * 0.2)
    return float(priority * 1.2 + waiting_score - retry_penalty)


def _recover_stale_tasks(
    scope: str,
    claimed_tasks: Optional[List[Dict[str, Any]]] = None,
    running_tasks: Optional[List[Dict[str, Any]]] = None,
) -> None:
    """
    回收长时间卡住的 claimed/running 任务，避免前端看到“创建后无反应”。
    - claimed 超时：回退 available，等待重新分发
    - running 超时：标记 failed，保留 thread_id 便于排障
    """
    now = datetime.now(timezone.utc)
    store = _get_store()
    if store is None:
        return

    try:
        claimed_rows = claimed_tasks if isinstance(claimed_tasks, list) else []
        running_rows = running_tasks if isinstance(running_tasks, list) else []
        from backend.engine.tasks.task_bidding import list_board_tasks

        if _claimed_timeout_seconds > 0 and not claimed_rows:
            claimed_rows = list_board_tasks(scope=scope, status="claimed", limit=200)
        if _running_timeout_seconds > 0 and not running_rows:
            running_rows = list_board_tasks(scope=scope, status="running", limit=200)

        for task in claimed_rows:
            task_id = str(task.get("id") or task.get("task_id") or "")
            if not task_id:
                continue
            updated_at = _parse_iso_ts(task.get("updated_at")) or _parse_iso_ts(task.get("created_at"))
            if updated_at is None:
                continue
            if (now - updated_at).total_seconds() < _claimed_timeout_seconds:
                continue
            out = store.get(_board_ns_for_scope(scope), task_id)
            if not out:
                continue
            val = getattr(out, "value", out) if not isinstance(out, dict) else out
            task_val = dict(val) if isinstance(val, dict) else {}
            if str(task_val.get("status") or "").strip().lower() != "claimed":
                continue
            timeout_count = int(task_val.get("queue_timeout_count", 0) or 0) + 1
            task_val["queue_timeout_count"] = timeout_count
            if timeout_count > MAX_QUEUE_TIMEOUT_RETRIES:
                thread_id = str(task_val.get("thread_id") or "") or None
                _set_task_failed(
                    scope,
                    task_id,
                    f"超过最大排队超时次数（{MAX_QUEUE_TIMEOUT_RETRIES}）",
                    thread_id or "",
                    dispatch_state="queue_timeout",
                )
                continue
            task_val["status"] = "available"
            task_val["claimed_by"] = None
            task_val["dispatch_state"] = "queue_timeout"
            task_val["progress_message"] = "queue_timeout_requeued"
            task_val["updated_at"] = now.isoformat()
            try:
                from backend.engine.tasks.task_bidding import project_board_task_status

                if project_board_task_status(
                    task_id=task_id,
                    status="available",
                    scope=scope,
                    thread_id=str(task_val.get("thread_id") or "") or None,
                    progress=(int(task_val.get("progress")) if isinstance(task_val.get("progress"), (int, float)) else None),
                    progress_message=str(task_val.get("progress_message") or ""),
                    dispatch_state="queue_timeout",
                    claimed_by=None,
                    source="task_watcher_requeue_timeout",
                    only_when_status_in={"claimed"},
                ):
                    continue
            except Exception:
                pass
            logger.warning("projection write failed: skip direct requeue fallback task_id=%s scope=%s", task_id, scope)

        for task in running_rows:
            task_id = str(task.get("id") or task.get("task_id") or "")
            if not task_id:
                continue
            running_task = _executor_tasks.get(task_id)
            if running_task is not None and not running_task.done():
                continue
            updated_at = _parse_iso_ts(task.get("updated_at")) or _parse_iso_ts(task.get("created_at"))
            if updated_at is None:
                continue
            if (now - updated_at).total_seconds() < _running_timeout_seconds:
                continue
            thread_id = str(task.get("thread_id") or "")
            _set_task_failed(
                scope,
                task_id,
                "running timeout exceeded",
                thread_id,
                dispatch_state="execution_timeout",
            )
    except Exception as e:
        logger.debug("stale task recovery failed: %s", e)


def _extract_result_summary(final_state: Any) -> str:
    if not isinstance(final_state, dict):
        return ""
    msgs = final_state.get("messages", []) or []
    for msg in reversed(msgs):
        msg_type = str(getattr(msg, "type", "") or "").lower()
        if msg_type and msg_type not in {"ai", "assistant"}:
            continue
        content = getattr(msg, "content", None)
        if content is None:
            continue
        if isinstance(content, list):
            text = " ".join(str(item) for item in content if item is not None).strip()
        else:
            text = str(content).strip()
        if text:
            return text[:5000]
    return ""


def _build_autonomous_prompt(task: Dict[str, Any]) -> str:
    raw_subject = str(task.get("subject") or "").strip()
    raw_description = str(task.get("description") or "").strip()
    subject = _sanitize_prompt_value(raw_subject, 500)
    description = _sanitize_prompt_value(raw_description, 2000)
    task_type = str(task.get("task_type") or "").strip().lower()
    skill_profile = str(task.get("skill_profile") or "").strip().lower()
    required_skills = [str(s).strip().lower() for s in (task.get("required_skills") or []) if str(s).strip()]
    raw_steps = [str(s).strip() for s in (task.get("steps") or []) if str(s).strip()]
    configured_steps = [_sanitize_prompt_value(s, 500) for s in raw_steps]
    is_ontology = (
        task_type in {"ontology_maintenance", "ontology_self_improve"}
        or skill_profile in {"ontology", "knowledge"}
        or any("ontology" in s or "knowledge" in s for s in required_skills)
    )
    is_prep = (
        task_type == "autonomous_prep"
        or any(x in subject.lower() for x in ["整理", "准备", "预处理", "分解"])
    )
    try:
        from backend.engine.tasks.task_orchestrator import decompose_task_with_llm
        subtasks = decompose_task_with_llm(task)
    except Exception:
        subtasks = []
    subtask_block = ""
    if subtasks:
        lines = ["\n子任务建议（由 TaskOrchestrator 生成）："]
        for idx, st in enumerate(subtasks, 1):
            lines.append(
                f"{idx}. {st.get('title', f'subtask_{idx}')}: {st.get('description', '')} "
                f"(role_hint={st.get('role_hint', '')}, priority={st.get('priority', idx)})"
            )
        subtask_block = "\n" + "\n".join(lines)
    steps_block = ""
    if configured_steps:
        step_lines = ["\n建议执行步骤（任务预设）："]
        for idx, step in enumerate(configured_steps, 1):
            step_lines.append(f"<step number=\"{idx}\">\n{step}\n</step>")
        steps_block = "\n" + "\n".join(step_lines)

    subject_text = subject or "未命名任务"
    desc_text = description or "（无）"
    if is_ontology:
        return (
            "你正在执行【本体维护自治任务】。\n"
            "目标：完成增量提取、差异比对、合并建议。\n\n"
            "<task_subject>\n" + subject_text + "\n</task_subject>\n"
            "<task_description>\n" + desc_text + "\n</task_description>\n\n"
            "执行要求：\n"
            "1) 扫描新增资料并提取概念/关系增量；\n"
            "2) 与现有本体做 diff，输出新增、冲突、冗余；\n"
            "3) 给出可执行合并建议与置信度；\n"
            "4) 输出最终结论与后续建议。"
            f"{steps_block}"
            f"{subtask_block}"
        )
    if is_prep:
        return (
            "你正在执行【自主准备任务 autonomous_prep】。\n"
            "目标：提前完成资料整理、任务拆解、执行准备。\n\n"
            "<task_subject>\n" + subject_text + "\n</task_subject>\n"
            "<task_description>\n" + desc_text + "\n</task_description>\n\n"
            "执行要求：\n"
            "1) 先产出准备清单（资料、工具、依赖、风险）；\n"
            "2) 形成任务拆解与优先级；\n"
            "3) 给出可直接执行的下一步动作；\n"
            "4) 输出最终准备结果。"
            f"{steps_block}"
            f"{subtask_block}"
        )
    is_bidding = skill_profile == "bidding"
    if is_bidding:
        return (
            "你正在执行【招投标方案任务】。\n"
            "目标：根据招标要求与已提供资料，生成投标方案（含大纲与正文）。\n\n"
            "<task_subject>\n" + subject_text + "\n</task_subject>\n"
            "<task_description>\n" + desc_text + "\n</task_description>\n\n"
            "执行要求：\n"
            "1) 理解招标需求与关键条款；\n"
            "2) 生成投标方案大纲；\n"
            "3) 按章节生成完整方案内容；\n"
            "4) 输出最终方案摘要与关键产出。"
            f"{steps_block}"
            f"{subtask_block}"
        )
    return (
        "请自主完成以下任务并输出可执行结果。\n\n"
        "<task_subject>\n" + subject_text + "\n</task_subject>\n"
        "<task_description>\n" + desc_text + "\n</task_description>\n\n"
        "要求：按 Agent 模式执行，必要时调用工具，并给出最终结论与关键产出。"
        f"{steps_block}"
        f"{subtask_block}"
    )


async def _execute_claimed_task(task: Dict[str, Any], assistant_id: str, scope: str) -> None:
    task_id = str(task.get("id") or task.get("task_id") or "")
    if not task_id:
        return
    thread_id = f"auto-{uuid.uuid4()}"
    try:
        _set_task_running(scope, task_id, thread_id)
        from langchain_core.messages import HumanMessage
        from backend.engine.core.main_graph import graph

        prompt = _build_autonomous_prompt(task)
        invoke_input = {"messages": [HumanMessage(content=prompt)]}
        invoke_config = {
            "run_name": "autonomous",
            "configurable": {
                "thread_id": thread_id,
                "request_id": str(task.get("request_id") or uuid.uuid4()),
                "request_enqueued_at": task.get("request_enqueued_at") or int(time.time() * 1000),
                "session_id": str(task.get("session_id") or thread_id),
                "task_key": str(task.get("task_id") or task_id),
                "mode": "agent",
                "assistant_id": assistant_id,
                "user_id": "autonomous_watcher",
                "task_type": (str(task.get("task_type") or "").strip() or "autonomous_task"),
                "cost_tier": str(task.get("cost_tier") or "medium"),
                **({"skill_profile": str(task.get("skill_profile") or "").strip()} if str(task.get("skill_profile") or "").strip() else {}),
                **({"workspace_path": str(task["workspace_path"]).strip()} if task.get("workspace_path") else {}),
            }
        }
        invoke_task = asyncio.create_task(
            graph.ainvoke(
                invoke_input,
                config=invoke_config,
            )
        )
        try:
            if _running_timeout_seconds > 0:
                final_state = await asyncio.wait_for(invoke_task, timeout=float(_running_timeout_seconds))
            else:
                final_state = await invoke_task
        except NotImplementedError as e:
            msg = str(e)
            if "does not support async methods" not in msg:
                raise
            logger.warning(
                "watcher 检测到同步 checkpointer，降级到 graph.invoke: task_id=%s",
                task_id,
            )
            # 某些 LangGraph/SqliteSaver 组合不支持 async checkpointer 调用；降级为同步 invoke 可保持功能可用。
            sync_invoke = asyncio.to_thread(graph.invoke, invoke_input, invoke_config)
            if _running_timeout_seconds > 0:
                final_state = await asyncio.wait_for(sync_invoke, timeout=float(_running_timeout_seconds))
            else:
                final_state = await sync_invoke
        except asyncio.TimeoutError:
            if not invoke_task.done():
                invoke_task.cancel()
                try:
                    await invoke_task
                except (Exception, asyncio.CancelledError):
                    pass
            _set_task_failed(
                scope,
                task_id,
                f"execution_timeout: exceeded {_running_timeout_seconds}s",
                thread_id,
                dispatch_state="execution_timeout",
            )
            return
        # main_graph finally 中会尝试回写看板状态；这里做幂等兜底，避免重复覆盖写入
        result_summary = _extract_result_summary(final_state)
        # 通用后置质量门：仅拒绝空摘要，短输出不误杀。
        if not isinstance(result_summary, str) or not result_summary.strip():
            _set_task_failed(scope, task_id, "post_verify_failed: empty_result_summary", thread_id, dispatch_state="post_verify_failed")
            return

        # 知识工程任务完成后执行额外质量门，未通过不标记完成。
        task_type = str(task.get("task_type") or "").strip().lower()
        if (
            task_type.startswith("kb_")
            or task_type.startswith("kb-")
            or "knowledge" in task_type
            or "ontology" in task_type
            or "bootstrap" in task_type
        ):
            try:
                schema_path = _get_project_root() / "knowledge_base" / "learned" / "audits" / "autonomous_result.schema.json"
                if not schema_path.exists():
                    schema_path.parent.mkdir(parents=True, exist_ok=True)
                    content = (
                        json.dumps(
                            {
                                "type": "object",
                                "properties": {
                                    "task_type": {"type": "string"},
                                    "result_summary": {"type": "string", "minLength": 10},
                                },
                                "required": ["task_type", "result_summary"],
                            },
                            ensure_ascii=False,
                            indent=2,
                        )
                        + "\n"
                    )
                    await asyncio.to_thread(schema_path.write_text, content, encoding="utf-8")
                from backend.tools.base.verify_tools import verify_output

                verification_raw = verify_output.invoke(
                    {
                        "output": json.dumps({"task_type": task_type, "result_summary": result_summary}, ensure_ascii=False),
                        "schema_path": str(schema_path),
                    }
                )
                try:
                    verification = json.loads(str(verification_raw))
                except Exception:
                    verification = {"ok": False, "error": "verify_output_parse_failed"}
                if not bool(verification.get("ok")):
                    _set_task_failed(scope, task_id, f"post_verify_failed: {verification.get('error')}", thread_id, dispatch_state="post_verify_failed")
                    return
            except Exception as verify_err:
                _set_task_failed(scope, task_id, f"post_verify_exception: {verify_err}", thread_id, dispatch_state="post_verify_exception")
                return
        _status = _get_task_status(scope, task_id).strip().lower()
        if _status in {"running", "claimed", "available", ""}:
            _set_task_completed(scope, task_id, result_summary, thread_id)
            try:
                from backend.engine.tasks.execution_docs import write_execution_summary
                workspace_path = str(task.get("workspace_path") or "").strip() or None
                await asyncio.to_thread(
                    write_execution_summary,
                    workspace_path,
                    task_id,
                    thread_id,
                    result_summary,
                )
            except Exception as _doc_err:
                logger.debug("execution_docs write_execution_summary skipped: %s", _doc_err)
            async with _get_executor_state_lock():
                _record_daily_autonomous_task_usage(
                    scope=scope,
                    task_type=str(task.get("task_type") or "autonomous_task"),
                )
            try:
                get_collective_learning().add_success(
                    {
                        "agent_id": assistant_id,
                        "task_id": task_id,
                        "task_type": str(task.get("task_type") or task.get("skill_profile") or ""),
                        "scope": scope,
                    }
                )
            except Exception:
                pass
    except Exception as e:
        logger.exception("autonomous execute failed: task_id=%s", task_id)
        _set_task_failed(scope, task_id, str(e), thread_id)
        try:
            get_collective_learning().add_failure(
                {
                    "agent_id": assistant_id,
                    "task_id": task_id,
                    "task_type": str(task.get("task_type") or task.get("skill_profile") or ""),
                    "scope": scope,
                    "error": str(e),
                }
            )
        except Exception:
            pass
    finally:
        await _unregister_executor_task(task_id)


async def register_builtin_autonomous_tasks() -> None:
    """注册内置自主任务（幂等，重复调用安全）。"""
    try:
        from backend.tools.base.paths import get_project_root
        from backend.engine.tasks.task_bidding import list_board_tasks
        cfg_path = get_project_root() / "backend" / "config" / "autonomous_tasks.json"
        if not cfg_path.exists():
            return
        tasks_cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        if not isinstance(tasks_cfg, list):
            return

        existing = list_board_tasks(scope="personal", status=None, limit=500)
        existing_subjects = {str((t or {}).get("subject") or "").strip() for t in existing}

        for item in tasks_cfg:
            if not isinstance(item, dict) or not item.get("enabled", False):
                continue
            subject = str(item.get("subject", "") or "").strip()
            description = str(item.get("description", "") or "").strip()
            task_type = str(item.get("task_type", "") or "").strip()
            role_id = str(item.get("role_id", "") or "").strip()
            auto_assign = bool(item.get("auto_assign", False))
            required_skills = item.get("required_skills") if isinstance(item.get("required_skills"), list) else None
            if not subject or subject in existing_subjects:
                continue
            await _create_board_autonomous_task(
                scope="personal",
                subject=subject,
                description=description or subject,
                task_type=task_type,
                required_skills=required_skills,
                auto_assign=auto_assign,
                preferred_role_id=role_id,
            )
            logger.info("已注册内置自主任务: %s", subject)
    except Exception as e:
        logger.debug("注册内置自主任务失败: %s", e)


async def _create_board_autonomous_task(
    scope: str,
    subject: str,
    description: str,
    task_type: str = "",
    required_skills: Optional[List[str]] = None,
    auto_assign: bool = False,
    preferred_role_id: str = "",
) -> Dict[str, Any]:
    """统一自治任务创建入口：直接写入看板并按需触发即时分发。"""
    store = _get_store()
    if store is None:
        raise RuntimeError("Store 不可用")

    now = datetime.now(timezone.utc).isoformat()
    task_id = str(uuid.uuid4())
    normalized_scope = str(scope or "personal")
    normalized_role = str(preferred_role_id or "").strip()
    val = {
        "task_id": task_id,
        "request_id": str(uuid.uuid4()),
        "request_enqueued_at": int(time.time() * 1000),
        "session_id": task_id,
        "subject": str(subject or "").strip() or task_id,
        "description": str(description or "").strip() or str(subject or "").strip() or task_id,
        "status": "available",
        "priority": 3,
        "scope": normalized_scope,
        "source_channel": "autonomous",
        "cost_tier": "medium",
        "created_at": now,
        "updated_at": now,
        "splittable": False,
        "total_units": None,
        "claimed_units": 0,
        "unit_label": None,
        "parent_task_id": None,
        "subtask_ids": [],
        "required_skills": required_skills or [],
        "human_checkpoints": [],
        "skill_profile": "full",
        "license_tier": "free",
        "queue_timeout_seconds": _claimed_timeout_seconds,
        "execution_timeout_seconds": _running_timeout_seconds,
        "progress": 0,
        "progress_message": None,
        "external_task_id": None,
        "pricing": None,
        "bids": [],
        "claimed_by": None,
        "auto_assign": bool(auto_assign),
        "bid_deadline": None,
        "decision_points": [],
        "human_reviews": [],
        **({"task_type": task_type} if str(task_type or "").strip() else {}),
        **({"preferred_role_id": normalized_role} if normalized_role else {}),
    }
    await asyncio.to_thread(store.put, _board_ns_for_scope(normalized_scope), task_id, val)

    dispatch_state = "queued_manual" if not auto_assign else "dispatching"
    if auto_assign:
        await dispatch_task_once(
            task_id=task_id,
            scope=normalized_scope,
            preferred_role_id=normalized_role,
        )
    return {"task_id": task_id, "dispatch_state": dispatch_state}


async def watch_and_bid(
    assistant_id: str,
    scope: str = "personal",
    interval: int = 30,
    min_confidence: float = 0.6,
    max_parallel_executions: int = 1,
) -> None:
    """
    后台循环：定期扫描看板，对 available 任务做自评估并竞标。
    无可用任务时轮询间隔指数退避（30s -> 60s -> 120s -> 300s），有任务时恢复 30s。

    assistant_id: 当前 Agent/角色 ID（与 role_id 对应）
    scope: 看板范围
    interval: 基础扫描间隔秒数（有任务时使用）
    min_confidence: 仅当 evaluate_task_fit 的 confidence >= 此值时才提交竞标
    """
    from backend.engine.tasks.task_bidding import (
        list_board_tasks_by_statuses,
        evaluate_task_fit,
        submit_bid,
        resolve_bids,
        is_bid_deadline_passed,
    )
    current_interval = min(max(interval, WATCHER_INTERVAL_MIN), WATCHER_INTERVAL_MAX)
    interval_index = 0
    while True:
        try:
            await asyncio.sleep(current_interval)
            stale_scan = list_board_tasks_by_statuses(
                scope=scope,
                statuses={"claimed", "running"},
                limit_per_status=200,
                total_scan_limit=800,
            )
            _recover_stale_tasks(
                scope=scope,
                claimed_tasks=stale_scan.get("claimed", []),
                running_tasks=stale_scan.get("running", []),
            )
            live_scan = list_board_tasks_by_statuses(
                scope=scope,
                statuses={"available", "bidding", "claimed"},
                limit_per_status=50,
                total_scan_limit=600,
            )
            available = sorted(
                live_scan.get("available", []),
                key=_fair_dispatch_rank,
                reverse=True,
            )
            had_work = False
            agent_profile = _get_role_config(assistant_id) or {}
            agent_skills = _get_role_skills(assistant_id)
            agent_load = _get_agent_load(assistant_id, scope=scope)
            if int(agent_load.get("running_tasks", 0) or 0) >= _spawn_trigger_running_tasks and available:
                await _maybe_request_spawn(
                    assistant_id,
                    f"watcher high_load running={agent_load.get('running_tasks')} available={len(available)}",
                )
            for task in available:
                task_id = task.get("id") or task.get("task_id")
                if not task_id:
                    continue
                if is_bid_deadline_passed(task):
                    continue
                bids = [b for b in (task.get("bids") or []) if isinstance(b, dict)]
                if any(b.get("agent_id") == assistant_id for b in bids):
                    continue
                try:
                    gate = _resource_gate(assistant_id, scope=scope)
                    if not gate.get("ok"):
                        _log_dispatch_decision(
                            "watcher_bid_skipped_resource_gate",
                            str(task_id),
                            scope,
                            role_id=assistant_id,
                            reason=str(gate.get("reason") or ""),
                            running=int(gate.get("running", 0) or 0),
                            slots=int(gate.get("slots", 1) or 1),
                        )
                        continue
                    dynamic_min = _adjusted_min_confidence(min_confidence, assistant_id, task)
                    fit = await evaluate_task_fit(
                        task_subject=task.get("subject", ""),
                        task_description=task.get("description", ""),
                        task_tags=task.get("required_skills") or [],
                        agent_profile=agent_profile,
                        agent_skills=agent_skills,
                        agent_load=agent_load,
                    )
                    if fit.get("can_handle") and float(fit.get("confidence", 0)) >= dynamic_min:
                        await submit_bid(task_id, assistant_id, fit, scope=scope)
                        logger.info("watcher 已竞标: task_id=%s agent_id=%s", task_id, assistant_id)
                        _log_dispatch_decision(
                            "watcher_bid_submitted",
                            str(task_id),
                            scope,
                            role_id=assistant_id,
                            confidence=float(fit.get("confidence", 0) or 0),
                            dynamic_min=dynamic_min,
                        )
                        had_work = True
                except Exception as e:
                    logger.debug("watcher 竞标失败 task_id=%s: %s", task_id, e)

            # 处理 A2A incoming invites：自动评估并回调竞标
            try:
                import httpx
                global _a2a_http_client
                async with _get_a2a_client_lock():
                    if _a2a_http_client is None:
                        _a2a_http_client = httpx.AsyncClient(timeout=20.0)
                    client = _a2a_http_client
                store = _get_store()
                if store is not None:
                    for row in _list_invites_items(store, limit=30):
                        _bump_invite_observability("rows_seen", 1)
                        invite_id = str(row.get("id") or "").strip()
                        if not invite_id:
                            continue
                        invite = dict(row)
                        invite.pop("id", None)
                        if invite.get("status") not in {"received", "retry"}:
                            continue
                        retry_count = int(invite.get("retry_count") or 0)
                        if retry_count >= _A2A_INVITE_MAX_RETRIES:
                            invite["status"] = "failed"
                            invite["updated_at"] = datetime.now(timezone.utc).isoformat()
                            store.put(_invites_ns(), invite_id, invite)
                            _bump_invite_observability("failed_max_retries", 1)
                            continue
                        _bump_invite_observability("processable_rows", 1)
                        cb = str(invite.get("callback_url") or "").strip()
                        task_subject = str(invite.get("subject") or "").strip()
                        task_desc = str(invite.get("description") or "").strip()
                        task_tags = invite.get("required_skills") or []
                        if not cb:
                            invite["status"] = "ignored"
                            store.put(_invites_ns(), invite_id, invite)
                            _bump_invite_observability("ignored", 1)
                            continue
                        if not _is_safe_callback_url(cb):
                            invite["status"] = "ignored"
                            invite["updated_at"] = datetime.now(timezone.utc).isoformat()
                            store.put(_invites_ns(), invite_id, invite)
                            _bump_invite_observability("ignored", 1)
                            continue
                        fit = await evaluate_task_fit(
                            task_subject=task_subject,
                            task_description=task_desc,
                            task_tags=task_tags if isinstance(task_tags, list) else [],
                            agent_profile=agent_profile,
                            agent_skills=agent_skills,
                            agent_load=agent_load,
                        )
                        if not (fit.get("can_handle") and float(fit.get("confidence", 0)) >= min_confidence):
                            invite["status"] = "skipped"
                            invite["updated_at"] = datetime.now(timezone.utc).isoformat()
                            store.put(_invites_ns(), invite_id, invite)
                            _bump_invite_observability("skipped", 1)
                            continue
                        task_id = str(invite.get("task_id") or "").strip()
                        if not task_id:
                            invite["status"] = "invalid"
                            store.put(_invites_ns(), invite_id, invite)
                            _bump_invite_observability("invalid", 1)
                            continue

                        endpoint = f"{cb.rstrip('/')}/board/tasks/{task_id}/bids"
                        payload = {
                            "agent_id": assistant_id,
                            "confidence": float(fit.get("confidence", 0)),
                            "reason": str(fit.get("reason") or "autonomous_watcher_invite_bid"),
                            "estimated_effort": str(fit.get("estimated_effort") or "medium"),
                        }
                        resp = await client.post(endpoint, json=payload)
                        invite["status"] = "bid_submitted" if resp.status_code < 400 else "bid_failed"
                        invite["last_bid_status_code"] = resp.status_code
                        invite["retry_count"] = retry_count + 1
                        invite["updated_at"] = datetime.now(timezone.utc).isoformat()
                        store.put(_invites_ns(), invite_id, invite)
                        _bump_invite_observability("bid_submitted" if resp.status_code < 400 else "bid_failed", 1)
                        if resp.status_code < 400:
                            had_work = True
            except Exception as invite_err:
                _bump_invite_observability("loop_errors", 1)
                _set_invite_observability("last_error", str(invite_err))
                logger.debug("watcher 处理 invites 失败（非关键）: %s", invite_err)

            # 竞标结束后自动决策：若到截止时间或仅单个竞标，自动从 bidding 推进到 claimed
            bidding_tasks = live_scan.get("bidding", [])
            for task in bidding_tasks:
                task_id = str(task.get("id") or task.get("task_id") or "")
                if not task_id or str(task.get("claimed_by") or "").strip():
                    continue
                bids = [b for b in (task.get("bids") or []) if isinstance(b, dict)]
                if not bids:
                    continue
                if not (is_bid_deadline_passed(task) or len(bids) == 1):
                    continue
                try:
                    result = await resolve_bids(task_id, strategy="fair_weighted", scope=scope)
                    if result.get("ok"):
                        had_work = True
                        logger.info(
                            "watcher 已自动认领分配: task_id=%s claimed_by=%s",
                            task_id,
                            result.get("claimed_by"),
                        )
                except Exception as e:
                    logger.debug("watcher 自动认领失败 task_id=%s: %s", task_id, e)

            # 对已认领且归属当前 Agent 的任务，自动创建执行线程并启动执行
            claimed = live_scan.get("claimed", [])
            for task in claimed:
                task_id = str(task.get("id") or task.get("task_id") or "")
                if not task_id:
                    continue
                if str(task.get("claimed_by") or "") != assistant_id:
                    continue
                if str(task.get("status") or "") == "running":
                    continue
                running_for_agent = await _running_for_agent(assistant_id)
                if running_for_agent >= max(1, int(max_parallel_executions or 1)):
                    continue
                started = await _register_executor_task(
                    task_id,
                    assistant_id,
                    lambda t=task, a=assistant_id, s=scope: _execute_claimed_task(t, assistant_id=a, scope=s),
                )
                if started:
                    had_work = True
                    logger.info("watcher 已启动自治执行: task_id=%s agent_id=%s", task_id, assistant_id)
            # 无可用任务时退避，有任务或曾竞标时恢复基础间隔
            if available or had_work:
                current_interval = min(max(interval, WATCHER_INTERVAL_MIN), WATCHER_INTERVAL_MAX)
                interval_index = 0
            else:
                interval_index = min(interval_index + 1, len(WATCHER_INTERVALS) - 1)
                current_interval = WATCHER_INTERVALS[interval_index]
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.exception("task_watcher loop error: %s", e)
            await asyncio.sleep(min(60, current_interval))


def start_watcher_background(
    assistant_id: str,
    scope: str = "personal",
    interval: Optional[int] = None,
    role_ids: Optional[List[str]] = None,
    max_parallel_executions: Optional[int] = None,
) -> None:
    """启动巡检后台任务（兼容单角色，支持多角色 worker 并行）。"""
    global _watcher_task, _scheduler_task, _watcher_assistant_id, _watcher_scope, _watcher_role_ids, _watcher_max_parallel_executions
    enabled = str(os.getenv("TASK_WATCHER_ENABLED", "false")).lower() in {"1", "true", "yes", "on"}
    if not enabled:
        logger.info("TASK_WATCHER_ENABLED=false，跳过 task_watcher 启动")
        return
    try:
        loop = asyncio.get_running_loop()
        _watcher_max_parallel_executions = max(1, int(max_parallel_executions or _watcher_max_parallel_executions or 1))
        role_list = [str(r or "").strip() for r in (role_ids or [assistant_id]) if str(r or "").strip()]
        if not role_list:
            role_list = [str(assistant_id or "").strip()]
        with _watcher_globals_lock:
            _watcher_assistant_id = str(assistant_id or "")
            _watcher_scope = str(scope or "personal")
            _watcher_role_ids = role_list

        # 兼容历史单 task 变量：保留首个 watcher 到 _watcher_task
        for idx, role in enumerate(role_list):
            t = _watcher_tasks.get(role)
            if t is not None and not t.done():
                continue
            task = loop.create_task(
                watch_and_bid(
                    role,
                    scope=scope,
                    interval=interval or _watcher_interval,
                    max_parallel_executions=_watcher_max_parallel_executions,
                )
            )
            _watcher_tasks[role] = task
            if idx == 0:
                _watcher_task = task
        if _scheduler_task is None or _scheduler_task.done():
            _scheduler_task = loop.create_task(_run_scheduled_autonomous_tasks())
        logger.info(
            "task_watcher 已启动: roles=%s scope=%s interval=%s max_parallel_executions=%s",
            role_list,
            scope,
            interval or _watcher_interval,
            _watcher_max_parallel_executions,
        )
    except RuntimeError:
        logger.debug("无法启动 task_watcher：无运行中的事件循环")


def stop_watcher_background() -> None:
    """停止巡检后台任务。"""
    global _watcher_task, _scheduler_task, _watcher_assistant_id, _watcher_scope, _watcher_role_ids, _executor_task_agents
    if _watcher_task and not _watcher_task.done():
        _watcher_task.cancel()
        _watcher_task = None
    with _stop_lock:
        for role_id, task in list(_watcher_tasks.items()):
            if task and not task.done():
                task.cancel()
            _watcher_tasks.pop(role_id, None)
    if _scheduler_task and not _scheduler_task.done():
        _scheduler_task.cancel()
        _scheduler_task = None
    with _stop_lock:
        for task_id, task in list(_executor_tasks.items()):
            if not task.done():
                task.cancel()
            _executor_tasks.pop(task_id, None)
        _executor_task_agents.clear()
    with _watcher_globals_lock:
        _watcher_assistant_id = ""
        _watcher_role_ids = []
        _watcher_scope = "personal"


async def stop_watcher_background_async() -> None:
    """停止巡检后台任务并等待所有 executor 任务结束（避免资源泄漏）。"""
    global _watcher_task, _scheduler_task, _watcher_assistant_id, _watcher_scope, _watcher_role_ids, _a2a_http_client
    if _watcher_task and not _watcher_task.done():
        _watcher_task.cancel()
        _watcher_task = None
    for role_id, task in list(_watcher_tasks.items()):
        if task and not task.done():
            task.cancel()
        _watcher_tasks.pop(role_id, None)
    if _scheduler_task and not _scheduler_task.done():
        _scheduler_task.cancel()
        _scheduler_task = None
    to_await = []
    for task_id, task in list(_executor_tasks.items()):
        if not task.done():
            task.cancel()
        to_await.append(task)
        _executor_tasks.pop(task_id, None)
    if to_await:
        await asyncio.gather(*to_await, return_exceptions=True)
    with _watcher_globals_lock:
        _watcher_assistant_id = ""
        _watcher_role_ids = []
        _watcher_scope = "personal"
    if _a2a_http_client is not None:
        try:
            await _a2a_http_client.aclose()
        except Exception:
            pass
        _a2a_http_client = None


def get_watcher_runtime_state() -> Dict[str, Any]:
    """获取 watcher 运行时状态（用于设置页展示）。"""
    with _watcher_globals_lock:
        assistant_id = _watcher_assistant_id
        role_ids = list(_watcher_role_ids)
        scope = _watcher_scope
    return {
        "enabled": bool(any(not t.done() for t in _watcher_tasks.values()) if _watcher_tasks else (_watcher_task is not None and not _watcher_task.done())),
        "assistant_id": assistant_id,
        "role_ids": role_ids,
        "scope": scope,
        "scheduler_running": bool(_scheduler_task is not None and not _scheduler_task.done()),
        "max_parallel_executions": _watcher_max_parallel_executions,
        "executing_tasks": len([t for t in _executor_tasks.values() if not t.done()]),
        "invites_observability": _snapshot_invite_observability(),
    }
