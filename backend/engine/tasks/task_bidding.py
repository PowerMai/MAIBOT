"""
任务自治认领 - Agent 自评估与竞标

发布-认领模式：任务发布到看板后，各 Agent 自主判断是否适合执行并提交竞标，
由发布者或自动策略选择执行者。替代中央调度（task_router）的分配逻辑。
"""

import asyncio
import json
import logging
import os
import threading
import time
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from backend.config.store_namespaces import (
    NS_BOARD_PERSONAL,
    NS_BOARD_ORG,
    NS_BOARD_PUBLIC,
)
from backend.api.common import is_valid_thread_id_uuid
from backend.engine.tasks.store_access import get_task_store, board_ns_for_scope
from backend.engine.prompts.agent_prompts import _sanitize_prompt_value as _sanitize_prompt_value_for_bidding

logger = logging.getLogger(__name__)

_UNSET = object()

_BID_WRITE_LOCKS_MAX_SIZE = 500
_bid_write_locks: Dict[str, asyncio.Lock] = {}
_bid_write_locks_guard: Optional[asyncio.Lock] = None
_bid_write_locks_guard_init = threading.Lock()
_sync_bid_lock = threading.Lock()

# 核心引擎验收：accept-bid 等同任务并发仅允许一次成功，project_board_task_status 按 task 加锁
_project_status_locks: Dict[str, threading.Lock] = {}
_project_status_locks_guard = threading.Lock()
_PROJECT_STATUS_LOCKS_MAX = 1000

# Store 无 search 时的 fallback 扫描上限，避免 N+1 过大（有 search 时优先 store.search+内存过滤）
_SYNC_BOARD_FALLBACK_LIST_LIMIT = 80


def _get_project_status_lock(scope: str, task_id: str) -> threading.Lock:
    key = f"{scope}:{task_id}"
    with _project_status_locks_guard:
        if key not in _project_status_locks:
            if len(_project_status_locks) >= _PROJECT_STATUS_LOCKS_MAX:
                for k in list(_project_status_locks):
                    if not _project_status_locks[k].locked():
                        del _project_status_locks[k]
                        break
            _project_status_locks[key] = threading.Lock()
        return _project_status_locks[key]


def _ensure_bid_write_locks_guard() -> asyncio.Lock:
    global _bid_write_locks_guard
    with _bid_write_locks_guard_init:
        if _bid_write_locks_guard is None:
            _bid_write_locks_guard = asyncio.Lock()
        return _bid_write_locks_guard


async def _get_bid_write_lock(scope: str, task_id: str) -> asyncio.Lock:
    key = f"{scope}:{task_id}"
    guard = _ensure_bid_write_locks_guard()
    async with guard:
        if key not in _bid_write_locks:
            _bid_write_locks[key] = asyncio.Lock()
        if len(_bid_write_locks) > _BID_WRITE_LOCKS_MAX_SIZE:
            for k in list(_bid_write_locks):
                if not _bid_write_locks[k].locked():
                    del _bid_write_locks[k]
                    break
        return _bid_write_locks[key]

_TASK_SINGLE_SOURCE_ENABLED = os.environ.get("TASK_SINGLE_SOURCE_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}
_TASK_STATUS_STRICT_WRITE = os.environ.get("TASK_STATUS_STRICT_WRITE", "true").strip().lower() in {"1", "true", "yes", "on"}
_TASK_STATUS_AUTHORITY = str(os.environ.get("TASK_STATUS_AUTHORITY", "board") or "board").strip().lower()


def is_task_single_source_enabled() -> bool:
    """Expose current single-source feature gate for cross-module consistency."""
    return _TASK_SINGLE_SOURCE_ENABLED


def allow_task_status_fallback_writes() -> bool:
    """统一状态写入口开启后，禁用直写 fallback。"""
    return False


def get_task_status_authority() -> str:
    """External task status truth source: board (default) or thread."""
    return _TASK_STATUS_AUTHORITY if _TASK_STATUS_AUTHORITY in {"board", "thread"} else "board"


def _is_valid_board_transition(current_status: str, next_status: str) -> bool:
    current = str(current_status or "").strip().lower()
    target = str(next_status or "").strip().lower()
    if not target or current == target:
        return True
    try:
        from backend.engine.tasks.task_watcher import _is_valid_transition

        return bool(_is_valid_transition(current, target))
    except Exception as e:
        logger.warning("状态迁移校验异常，拒绝放行: %s", e)
        return False

try:
    from backend.engine.organization import get_resource_pool, get_collective_learning
except Exception:
    get_resource_pool = None  # type: ignore
    get_collective_learning = None  # type: ignore

def _board_ns_for_scope(scope: str) -> tuple:
    return board_ns_for_scope(scope)


def is_bid_deadline_passed(task: Dict[str, Any]) -> bool:
    """任务若设置了 bid_deadline 且已过期则返回 True，供 watcher 跳过。"""
    raw = task.get("bid_deadline") if isinstance(task, dict) else None
    if not raw or not isinstance(raw, str):
        return False
    try:
        s = raw.strip().replace("Z", "+00:00")
        deadline = datetime.fromisoformat(s)
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) > deadline
    except Exception:
        return False


def _get_store():
    return get_task_store()


def _extract_store_key(item: Any) -> Optional[str]:
    """从 store.search 返回的 item 中提取 key，与 board_api 逻辑一致。"""
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
    """从 store.search 返回的 item 中提取 value。"""
    if isinstance(item, tuple) and len(item) >= 2:
        return item[1]
    if isinstance(item, dict):
        if "value" in item:
            return item.get("value")
        return item
    return getattr(item, "value", item)


def _store_put_with_retry(store: Any, namespace: tuple, key: str, value: Dict[str, Any], retries: int = 3) -> None:
    """关键写路径轻量重试（同步），供 sync_board_task_by_thread_id 等同步调用点使用。"""
    last_err: Optional[Exception] = None
    for i in range(max(1, retries)):
        try:
            store.put(namespace, key, value)
            return
        except Exception as e:
            last_err = e
            if i < retries - 1:
                time.sleep(0.05 * (i + 1))
    raise RuntimeError(f"store.put failed after retries: ns={namespace} key={key} err={last_err}")


async def _store_put_with_retry_async(
    store: Any, namespace: tuple, key: str, value: Dict[str, Any], retries: int = 3
) -> None:
    """关键写路径轻量重试（异步），供 submit_bid / resolve_bids 等 async 调用点使用，避免阻塞事件循环。"""
    last_err: Optional[Exception] = None
    for i in range(max(1, retries)):
        try:
            await asyncio.to_thread(store.put, namespace, key, value)
            return
        except Exception as e:
            last_err = e
            if i < retries - 1:
                await asyncio.sleep(0.05 * (i + 1))
    raise RuntimeError(f"store.put failed after retries: ns={namespace} key={key} err={last_err}")


def _parse_ts(value: Any) -> Optional[datetime]:
    if value is None:
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


def _recent_agent_claim_counts(scope: str) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for st in ("claimed", "running"):
        for task in list_board_tasks(scope=scope, status=st, limit=500):
            aid = str(task.get("claimed_by") or "").strip()
            if not aid:
                continue
            counts[aid] = counts.get(aid, 0) + 1
    return counts


def _compute_fair_bid_score(task: Dict[str, Any], bid: Dict[str, Any], agent_claim_counts: Dict[str, int]) -> float:
    confidence = max(0.0, min(1.0, float(bid.get("confidence", 0) or 0)))
    skill_match = max(0.0, min(1.0, float(bid.get("skill_match", 0) or 0)))
    priority_raw = int(task.get("priority", 3) or 3)
    priority_norm = max(0.0, min(1.0, (priority_raw - 1) / 4.0))
    now = datetime.now(timezone.utc)
    enqueued = _parse_ts(task.get("request_enqueued_at")) or _parse_ts(task.get("created_at")) or now
    waiting_minutes = max(0.0, (now - enqueued).total_seconds() / 60.0)
    age_score = min(1.0, waiting_minutes / 60.0)
    retry_count = max(0, int(task.get("retry_count", 0) or 0))
    retry_penalty = min(1.0, retry_count / 5.0)
    effort = str(bid.get("estimated_effort", "medium") or "medium").lower()
    effort_penalty = {"low": 0.0, "medium": 0.08, "high": 0.16}.get(effort, 0.08)
    agent_id = str(bid.get("agent_id") or "").strip()
    agent_load_penalty = min(0.35, 0.08 * float(agent_claim_counts.get(agent_id, 0)))
    quota_penalty = 0.0
    learning_bonus = 0.0
    try:
        if get_resource_pool is not None:
            quota = get_resource_pool().get_quota(agent_id)
            slots = max(1, int(getattr(quota, "cpu_slots", 1) or 1))
            current_load = int(agent_claim_counts.get(agent_id, 0) or 0)
            if current_load >= slots:
                quota_penalty += min(0.25, 0.08 + 0.04 * (current_load - slots + 1))
            if float(getattr(quota, "usd_budget_daily", 0.0) or 0.0) > 0:
                cost_tier = str(task.get("cost_tier") or "medium").lower()
                if cost_tier == "high":
                    quota_penalty += 0.03
    except Exception:
        quota_penalty = 0.0

    try:
        if get_collective_learning is not None and agent_id:
            ttype = str(task.get("task_type") or task.get("skill_profile") or "").strip()
            lr = get_collective_learning().agent_recent_score(agent_id, task_type=ttype, limit=40)
            learning_bonus = max(-0.08, min(0.08, float(lr.get("score", 0.0)) * 0.08))
    except Exception:
        learning_bonus = 0.0
    # 置信度为主，等待时长/优先级做反饥饿补偿，再叠加负载与重试惩罚
    score = (
        confidence * 0.48
        + skill_match * 0.14
        + priority_norm * 0.16
        + age_score * 0.20
        - retry_penalty * 0.06
        - effort_penalty
        - agent_load_penalty
        - quota_penalty
        + learning_bonus
    )
    return float(score)


def _compute_skill_match(task_tags: List[str], agent_skills: List[str]) -> float:
    if not task_tags:
        return 0.5
    task_set = {str(t).strip().lower() for t in task_tags if str(t).strip()}
    skill_set = {str(s).strip().lower() for s in agent_skills if str(s).strip()}
    if not task_set:
        return 0.5
    if not skill_set:
        return 0.0
    hit = len(task_set & skill_set)
    return max(0.0, min(1.0, hit / max(1, len(task_set))))


async def evaluate_task_fit(
    task_subject: str,
    task_description: str,
    task_tags: Optional[List[str]] = None,
    agent_profile: Optional[Dict[str, Any]] = None,
    agent_skills: Optional[List[str]] = None,
    agent_load: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    让 LLM 判断当前 Agent 是否适合执行此任务（自评估）。

    Returns:
        {
            "can_handle": bool,
            "confidence": float,  # 0-1
            "reason": str,
            "estimated_effort": str,  # "low" | "medium" | "high"
        }
    """
    agent_profile = agent_profile or {}
    agent_skills = agent_skills or []
    agent_load = agent_load or {}
    task_tags = task_tags or []

    safe_subject = _sanitize_prompt_value_for_bidding(str(task_subject or ""), 300)
    safe_description = _sanitize_prompt_value_for_bidding(str(task_description or ""), 2000)
    safe_tags = ", ".join(_sanitize_prompt_value_for_bidding(str(t), 50) for t in (task_tags or []))
    safe_label = _sanitize_prompt_value_for_bidding(str(agent_profile.get("label") or "未知"), 100)
    safe_profile_desc = _sanitize_prompt_value_for_bidding(str(agent_profile.get("description") or "无"), 500)

    prompt = f"""你是一个数字员工（Agent），需要判断自己是否适合执行以下任务。

<task_subject>
{safe_subject}
</task_subject>
<task_description>
{safe_description or "（无）"}
</task_description>
<task_tags>{safe_tags or "无"}</task_tags>

当前 Agent 身份/能力：
- 角色：{safe_label}
- 描述：{safe_profile_desc}
- 技能集：{", ".join(agent_skills) if agent_skills else "无"}
- 当前负载：{json.dumps(agent_load, ensure_ascii=False)}

请仅输出一行 JSON，不要其他文字，格式如下：
{{"can_handle": true或false, "confidence": 0.0到1.0之间的数, "reason": "简短理由", "estimated_effort": "low或medium或high"}}
"""

    try:
        from langchain_core.messages import HumanMessage
        from backend.engine.agent.model_manager import get_model_manager
        manager = get_model_manager()
        llm = manager.create_llm(config=None)
        if llm is None:
            return _fallback_evaluate(task_subject, task_description, agent_profile, agent_skills, task_tags=task_tags)
        if hasattr(llm, "ainvoke"):
            msg = await llm.ainvoke([HumanMessage(content=prompt)])
        else:
            import asyncio
            msg = await asyncio.get_running_loop().run_in_executor(None, lambda: llm.invoke([HumanMessage(content=prompt)]))
        content = msg.content if hasattr(msg, "content") else str(msg)
        if not content:
            return _fallback_evaluate(task_subject, task_description, agent_profile, agent_skills, task_tags=task_tags)
        # 提取 JSON（可能被 markdown 包裹）
        text = content.strip()
        if "```" in text:
            for part in text.split("```"):
                part = part.strip()
                if part.startswith("json"):
                    part = part[4:].strip()
                if part.startswith("{"):
                    text = part
                    break
        if not text.startswith("{"):
            return _fallback_evaluate(task_subject, task_description, agent_profile, agent_skills, task_tags=task_tags)
        data = json.loads(text)
        llm_conf = max(0.0, min(1.0, float(data.get("confidence", 0))))
        skill_match = _compute_skill_match(task_tags, agent_skills)
        adjusted_conf = max(0.0, min(1.0, llm_conf * 0.85 + skill_match * 0.15))
        return {
            "can_handle": bool(data.get("can_handle", False)),
            "confidence": adjusted_conf,
            "skill_match": skill_match,
            "reason": str(data.get("reason", ""))[:500],
            "estimated_effort": str(data.get("estimated_effort", "medium")).lower()
            if str(data.get("estimated_effort", "medium")).lower() in ("low", "medium", "high")
            else "medium",
        }
    except Exception as e:
        logger.debug("evaluate_task_fit LLM 调用失败，使用降级规则: %s", e)
        return _fallback_evaluate(task_subject, task_description, agent_profile, agent_skills, task_tags=task_tags)


def _fallback_evaluate(
    task_subject: str,
    task_description: str,
    agent_profile: Dict[str, Any],
    agent_skills: List[str],
    task_tags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """无 LLM 时的简单关键词降级：任务主题/描述与角色描述、技能有交集则认为可处理。"""
    text = f"{task_subject} {task_description}".lower()
    desc = (agent_profile.get("description") or "").lower()
    label = (agent_profile.get("label") or "").lower()
    skills_str = " ".join(agent_skills).lower()
    combined = f"{desc} {label} {skills_str}"
    # 简单判断：有共同词则 can_handle
    words = set(w for w in text.split() if len(w) > 1)
    other = set(w for w in combined.split() if len(w) > 1)
    overlap = len(words & other) / max(len(words), 1)
    can_handle = overlap >= 0.1 or (not words and combined.strip())
    skill_match = _compute_skill_match(task_tags, agent_skills) if (task_tags and len(task_tags) > 0) else 0.0
    return {
        "can_handle": can_handle,
        "confidence": min(1.0, overlap + 0.2),
        "skill_match": skill_match,
        "reason": "降级规则：关键词匹配",
        "estimated_effort": "medium",
    }


async def submit_bid(
    task_id: str,
    agent_id: str,
    bid: Dict[str, Any],
    scope: str = "personal",
) -> None:
    """Agent 提交竞标到看板 Store。更新任务的 bids 列表，若状态为 available 则改为 bidding。"""
    lock = await _get_bid_write_lock(scope, task_id)
    async with lock:
        store = _get_store()
        if store is None:
            raise RuntimeError("Store 不可用")
        ns = _board_ns_for_scope(scope)
        out = await asyncio.to_thread(store.get, ns, task_id)
        if not out:
            raise ValueError(f"任务不存在: {task_id}")
        v = getattr(out, "value", out) if not isinstance(out, dict) else out
        val = dict(v) if isinstance(v, dict) else {}
        if val.get("status") not in ("available", "bidding"):
            raise ValueError(f"任务状态不允许竞标: {val.get('status')}")
        deadline_raw = val.get("bid_deadline")
        deadline = None
        if deadline_raw and isinstance(deadline_raw, str):
            try:
                s = deadline_raw.strip().replace("Z", "+00:00")
                deadline = datetime.fromisoformat(s)
                if deadline.tzinfo is None:
                    deadline = deadline.replace(tzinfo=timezone.utc)
            except (ValueError, AttributeError):
                deadline = None
        if deadline is not None and datetime.now(timezone.utc) > deadline:
            raise ValueError("竞标已截止")
        # 规范化 estimated_effort
        eff = (bid.get("estimated_effort") or "medium").lower().strip()
        if eff not in ("low", "medium", "high"):
            eff = "medium"
        bid_normalized = {**bid, "estimated_effort": eff}
        raw_bids = val.get("bids") or []
        bids = [b for b in raw_bids if isinstance(b, dict) and b.get("agent_id") != agent_id]
        MAX_BIDS_PER_TASK = 50
        if len(bids) >= MAX_BIDS_PER_TASK:
            bids.sort(key=lambda b: float(b.get("confidence", 0)), reverse=True)
            bids = bids[: MAX_BIDS_PER_TASK - 1]
        bids.append({
            "agent_id": agent_id,
            "confidence": bid_normalized.get("confidence", 0),
            "skill_match": bid_normalized.get("skill_match", 0),
            "reason": bid_normalized.get("reason", ""),
            "estimated_effort": bid_normalized.get("estimated_effort", "medium"),
            "bid_time": datetime.now(timezone.utc).isoformat(),
        })
        try:
            projected = await project_board_task_status_async(
                task_id=task_id,
                status="bidding",
                scope=scope,
                thread_id=str(val.get("thread_id") or "") or None,
                progress=(int(val.get("progress")) if isinstance(val.get("progress"), (int, float)) else None),
                progress_message=str(val.get("progress_message") or ""),
                dispatch_state=str(val.get("dispatch_state") or "") or None,
                claimed_by=(str(val.get("claimed_by") or "") or None),
                source="submit_bid",
                only_when_status_in={"available", "bidding"},
                extra_updates={"bids": bids},
            )
            if not projected:
                raise RuntimeError("竞标状态写入失败（可能被并发修改）")
        except Exception as e:
            raise RuntimeError(f"竞标状态写入失败: {e}") from e
        logger.info("竞标已提交: task_id=%s agent_id=%s confidence=%.2f", task_id, agent_id, bid.get("confidence", 0))


async def resolve_bids(
    task_id: str,
    strategy: str = "fair_weighted",
    scope: str = "personal",
) -> Dict[str, Any]:
    """
    从竞标中选择最优 Agent。更新任务为 claimed，写入 claimed_by。

    strategy: "best_confidence" | "lowest_effort" | "first"
    Returns:
        {"ok": bool, "claimed_by": str or None, "bid": dict or None, "error": str}
    """
    store = _get_store()
    if store is None:
        return {"ok": False, "claimed_by": None, "bid": None, "error": "Store 不可用"}
    ns = _board_ns_for_scope(scope)
    out = await asyncio.to_thread(store.get, ns, task_id)
    if not out:
        return {"ok": False, "claimed_by": None, "bid": None, "error": "任务不存在"}
    v = getattr(out, "value", out) if not isinstance(out, dict) else out
    val = dict(v) if isinstance(v, dict) else {}
    current_status = str(val.get("status") or "").strip().lower()
    if current_status not in {"available", "bidding"}:
        return {"ok": False, "claimed_by": None, "bid": None, "error": f"当前状态不允许决策: {current_status or 'unknown'}"}
    bids = [b for b in (val.get("bids") or []) if isinstance(b, dict)]
    if not bids:
        return {"ok": False, "claimed_by": None, "bid": None, "error": "无竞标"}

    effort_order = {"low": 0, "medium": 1, "high": 2}
    if strategy == "fair_weighted":
        agent_claim_counts = _recent_agent_claim_counts(scope=scope)
        chosen = max(
            bids,
            key=lambda b: (
                _compute_fair_bid_score(val, b, agent_claim_counts),
                float(b.get("confidence", 0)),
            ),
        )
    elif strategy == "best_confidence":
        chosen = max(
            bids,
            key=lambda b: (
                float(b.get("confidence", 0)),
                -effort_order.get(b.get("estimated_effort", "medium"), 1),
            ),
        )
    elif strategy == "lowest_effort":
        chosen = min(
            bids,
            key=lambda b: (
                effort_order.get(b.get("estimated_effort", "medium"), 1),
                -float(b.get("confidence", 0)),
            ),
        )
    else:
        chosen = bids[0]

    agent_id = chosen.get("agent_id")
    if not agent_id:
        return {"ok": False, "claimed_by": None, "bid": None, "error": "竞标缺少 agent_id"}
    try:
        projected = await project_board_task_status_async(
            task_id=task_id,
            status="claimed",
            scope=scope,
            thread_id=str(val.get("thread_id") or "") or None,
            progress=(int(val.get("progress")) if isinstance(val.get("progress"), (int, float)) else None),
            progress_message=str(val.get("progress_message") or ""),
            dispatch_state=str(val.get("dispatch_state") or "") or None,
            claimed_by=agent_id,
            source="resolve_bids",
            only_when_status_in={"available", "bidding"},
        )
        if not projected:
            return {"ok": False, "claimed_by": None, "bid": None, "error": "状态写入失败（可能被并发修改）"}
    except Exception as e:
        return {"ok": False, "claimed_by": None, "bid": None, "error": f"状态写入异常: {e}"}
    return {"ok": True, "claimed_by": agent_id, "bid": chosen, "error": None}


def get_bids(task_id: str, scope: str = "personal") -> List[Dict[str, Any]]:
    """获取任务的竞标列表。仅返回元素为 dict 的项，避免脏数据导致前端报错。"""
    store = _get_store()
    if store is None:
        return []
    ns = _board_ns_for_scope(scope)
    out = store.get(ns, task_id)
    if not out:
        return []
    v = getattr(out, "value", out) if not isinstance(out, dict) else out
    val = v if isinstance(v, dict) else {}
    raw = val.get("bids") or []
    return [b for b in raw if isinstance(b, dict)]


def list_board_tasks(scope: str = "personal", status: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
    """列出看板任务。status 可选：available, bidding, claimed, running, completed 等。优先 store.search 消除 N+1。"""
    store = _get_store()
    if store is None:
        return []
    ns = _board_ns_for_scope(scope)
    tasks = []
    try:
        allowed = {status} if status else None
        if status == "pending":
            allowed = {"pending", "available"}
        if hasattr(store, "search"):
            items = store.search(ns, limit=max(limit, 500))
            for item in items:
                k = _extract_store_key(item)
                v = _extract_store_value(item)
                if k is None or not isinstance(v, dict):
                    continue
                if allowed is not None and v.get("status") not in allowed:
                    continue
                tasks.append({"id": k, **v})
                if len(tasks) >= limit:
                    break
        else:
            keys = list(store.list(ns))[:limit]
            for k in keys:
                out = store.get(ns, k)
                if not out:
                    continue
                v = getattr(out, "value", out) if not isinstance(out, dict) else out
                if not isinstance(v, dict):
                    continue
                if allowed is not None and v.get("status") not in allowed:
                    continue
                tasks.append({"id": k, **v})
    except Exception as e:
        logger.debug("list_board_tasks: %s", e)
    return tasks


def list_board_tasks_by_statuses(
    scope: str = "personal",
    statuses: Optional[set[str]] = None,
    limit_per_status: int = 100,
    total_scan_limit: int = 500,
) -> Dict[str, List[Dict[str, Any]]]:
    """
    单次扫描按状态分桶返回任务，降低 watcher 热路径重复 list/get 开销。
    """
    store = _get_store()
    if store is None:
        return {}
    ns = _board_ns_for_scope(scope)
    normalized_statuses = {
        str(s or "").strip().lower()
        for s in (statuses or set())
        if str(s or "").strip()
    }
    if not normalized_statuses:
        return {}
    max_per_bucket = max(1, int(limit_per_status or 1))
    scan_limit = max(int(total_scan_limit or 0), len(normalized_statuses) * max_per_bucket)
    buckets: Dict[str, List[Dict[str, Any]]] = {s: [] for s in normalized_statuses}
    try:
        if hasattr(store, "search"):
            items = store.search(ns, limit=scan_limit)
            for item in items:
                k = _extract_store_key(item)
                v = _extract_store_value(item)
                if k is None or not isinstance(v, dict):
                    continue
                row_status = str(v.get("status") or "").strip().lower()
                if row_status not in normalized_statuses:
                    continue
                bucket = buckets.get(row_status)
                if bucket is None or len(bucket) >= max_per_bucket:
                    continue
                bucket.append({"id": k, **v})
                if all(len(rows) >= max_per_bucket for rows in buckets.values()):
                    break
        else:
            keys = list(store.list(ns))[:scan_limit]
            for k in keys:
                out = store.get(ns, k)
                if not out:
                    continue
                v = getattr(out, "value", out) if not isinstance(out, dict) else out
                if not isinstance(v, dict):
                    continue
                row_status = str(v.get("status") or "").strip().lower()
                if row_status not in normalized_statuses:
                    continue
                bucket = buckets.get(row_status)
                if bucket is None or len(bucket) >= max_per_bucket:
                    continue
                bucket.append({"id": k, **v})
                if all(len(rows) >= max_per_bucket for rows in buckets.values()):
                    break
    except Exception as e:
        logger.debug("list_board_tasks_by_statuses: %s", e)
    return buckets


def project_board_task_status(
    task_id: str,
    status: str,
    scope: str = "personal",
    *,
    thread_id: Optional[str] = None,
    result: Optional[str] = None,
    progress: Optional[int] = None,
    progress_message: Optional[str] = None,
    dispatch_state: Optional[str] = None,
    claimed_by: Optional[str] | object = _UNSET,
    only_when_claimed_by: Optional[str] | object = _UNSET,
    source: str = "task_watcher",
    only_when_status_in: Optional[set] = None,
    extra_updates: Optional[Dict[str, Any]] = None,
) -> bool:
    """
    统一看板状态写入口（Phase-1）。
    返回 True 表示写入成功；False 表示任务不存在、状态不允许或写入失败。
    """
    if not task_id:
        return False
    store = _get_store()
    if store is None:
        return False
    ns = _board_ns_for_scope(scope)
    lock = _get_project_status_lock(scope, task_id)
    with lock:
        try:
            out = store.get(ns, task_id)
            if not out:
                return False
            raw = getattr(out, "value", out) if not isinstance(out, dict) else out
            if not isinstance(raw, dict):
                return False
            val = dict(raw)
            current_status = str(val.get("status") or "").strip().lower()
            next_status = str(status or "").strip().lower()
            if not next_status:
                return False
            if only_when_status_in is not None and current_status not in {str(s).strip().lower() for s in only_when_status_in}:
                return False
            if only_when_claimed_by is not _UNSET:
                expected_claimed_by = str(only_when_claimed_by or "").strip()
                current_claimed_by = str(val.get("claimed_by") or "").strip()
                if current_claimed_by != expected_claimed_by:
                    return False
            if not _is_valid_board_transition(current_status, next_status):
                allow_reset_to_available = next_status == "available" and current_status in {
                    "failed",
                    "cancelled",
                    "paused",
                    "waiting_human",
                    "blocked",
                    "awaiting_plan_confirm",
                }
                if not allow_reset_to_available:
                    return False
            # paused 属于可恢复中间态，允许后续迁移（例如 human-review skip 后继续分发）。
            if current_status in {"completed", "failed", "cancelled"} and current_status != next_status:
                if not (next_status == "available" and current_status in {"failed", "cancelled"}):
                    return False

            val["status"] = next_status
            if thread_id is not None:
                val["thread_id"] = thread_id
            if result is not None:
                val["result"] = result[:5000] if len(result) > 5000 else result
            if progress is not None:
                val["progress"] = max(0, min(100, int(progress)))
            if progress_message is not None:
                val["progress_message"] = progress_message
            if dispatch_state is not None:
                val["dispatch_state"] = dispatch_state
            if claimed_by is not _UNSET:
                val["claimed_by"] = claimed_by
            if isinstance(extra_updates, dict):
                for k, v in extra_updates.items():
                    key = str(k or "").strip()
                    if not key or key in {
                        "status",
                        "status_projection_source",
                        "status_projection_at",
                        "updated_at",
                    }:
                        continue
                    val[key] = v

            if _TASK_SINGLE_SOURCE_ENABLED:
                val["status_projection_source"] = source
                val["status_projection_at"] = datetime.now(timezone.utc).isoformat()
                val["status_authority"] = get_task_status_authority()
            val["updated_at"] = datetime.now(timezone.utc).isoformat()
            _store_put_with_retry(store, ns, task_id, val)
            return True
        except Exception as e:
            logger.debug("project_board_task_status failed: task_id=%s scope=%s status=%s err=%s", task_id, scope, status, e)
            return False


async def project_board_task_status_async(
    task_id: str,
    status: str,
    scope: str = "personal",
    *,
    thread_id: Optional[str] = None,
    result: Optional[str] = None,
    progress: Optional[int] = None,
    progress_message: Optional[str] = None,
    dispatch_state: Optional[str] = None,
    claimed_by: Optional[str] | object = _UNSET,
    only_when_claimed_by: Optional[str] | object = _UNSET,
    source: str = "task_watcher",
    only_when_status_in: Optional[set] = None,
    extra_updates: Optional[Dict[str, Any]] = None,
) -> bool:
    """与 project_board_task_status 逻辑一致，使用异步重试避免阻塞事件循环。供 submit_bid / resolve_bids 使用。"""
    if not task_id:
        return False
    store = _get_store()
    if store is None:
        return False
    ns = _board_ns_for_scope(scope)
    try:
        out = await asyncio.to_thread(store.get, ns, task_id)
        if not out:
            return False
        raw = getattr(out, "value", out) if not isinstance(out, dict) else out
        if not isinstance(raw, dict):
            return False
        val = dict(raw)
        current_status = str(val.get("status") or "").strip().lower()
        next_status = str(status or "").strip().lower()
        if not next_status:
            return False
        if only_when_status_in is not None and current_status not in {str(s).strip().lower() for s in only_when_status_in}:
            return False
        if only_when_claimed_by is not _UNSET:
            expected_claimed_by = str(only_when_claimed_by or "").strip()
            current_claimed_by = str(val.get("claimed_by") or "").strip()
            if current_claimed_by != expected_claimed_by:
                return False
        if not _is_valid_board_transition(current_status, next_status):
            allow_reset_to_available = next_status == "available" and current_status in {
                "failed",
                "cancelled",
                "paused",
                "waiting_human",
                "blocked",
                "awaiting_plan_confirm",
            }
            if not allow_reset_to_available:
                return False
        if current_status in {"completed", "failed", "cancelled"} and current_status != next_status:
            if not (next_status == "available" and current_status in {"failed", "cancelled"}):
                return False

        val["status"] = next_status
        if thread_id is not None:
            val["thread_id"] = thread_id
        if result is not None:
            val["result"] = result[:5000] if len(result) > 5000 else result
        if progress is not None:
            val["progress"] = max(0, min(100, int(progress)))
        if progress_message is not None:
            val["progress_message"] = progress_message
        if dispatch_state is not None:
            val["dispatch_state"] = dispatch_state
        if claimed_by is not _UNSET:
            val["claimed_by"] = claimed_by
        if isinstance(extra_updates, dict):
            for k, v in extra_updates.items():
                key = str(k or "").strip()
                if not key or key in {
                    "status",
                    "status_projection_source",
                    "status_projection_at",
                    "updated_at",
                }:
                    continue
                val[key] = v

        if _TASK_SINGLE_SOURCE_ENABLED:
            val["status_projection_source"] = source
            val["status_projection_at"] = datetime.now(timezone.utc).isoformat()
            val["status_authority"] = get_task_status_authority()
        val["updated_at"] = datetime.now(timezone.utc).isoformat()
        await _store_put_with_retry_async(store, ns, task_id, val)
        return True
    except Exception as e:
        logger.debug(
            "project_board_task_status_async failed: task_id=%s scope=%s status=%s err=%s",
            task_id, scope, status, e,
        )
        return False


def _get_thread_task_status_history(thread_id: str) -> List[Dict[str, Any]]:
    """从 thread metadata 读取 task_status_history（同步，供 sync_board_task_by_thread_id 使用）。"""
    if not thread_id or thread_id == "unknown" or not is_valid_thread_id_uuid(thread_id):
        return []
    base_url = os.environ.get("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")
    url = f"{base_url}/threads/{thread_id}"
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:
            raw = resp.read().decode("utf-8", errors="ignore")
        payload = json.loads(raw) if raw else {}
        metadata = payload.get("metadata") if isinstance(payload, dict) else {}
        if not isinstance(metadata, dict):
            return []
        history = metadata.get("task_status_history")
        return history if isinstance(history, list) else []
    except Exception as e:
        logger.debug("get thread task_status_history (non-critical): %s", e)
        return []


def sync_board_task_by_thread_id(
    thread_id: str,
    status: str,
    result: Optional[str] = None,
) -> None:
    """
    运行完成后根据 thread_id 回写看板任务状态与结果。
    供 main_graph 在 update_task_status_sync 之后调用，仅更新 status=running 且 thread_id 匹配的任务。
    """
    normalized_status = str(status or "").strip().lower()
    if not thread_id or thread_id == "unknown" or not normalized_status:
        return
    store = _get_store()
    if store is None:
        return
    for scope, ns in [("personal", NS_BOARD_PERSONAL), ("org", NS_BOARD_ORG), ("public", NS_BOARD_PUBLIC)]:
        try:
            task_id, v = None, None
            # 使用 search 一次获取 (key, value)，按 thread_id 在内存中匹配，避免 list + N 次 get。
            if hasattr(store, "search"):
                for item in store.search(ns, limit=200):
                    task_id = _extract_store_key(item)
                    out = _extract_store_value(item)
                    if not task_id:
                        continue
                    v = getattr(out, "value", out) if not isinstance(out, dict) else out
                    if not isinstance(v, dict) or v.get("thread_id") != thread_id:
                        continue
                    break
                else:
                    task_id, v = None, None
            else:
                # N+1 fallback：Store 无 search 时仅扫描前 N 个 key，降低延迟与负载
                for k in list(store.list(ns))[:_SYNC_BOARD_FALLBACK_LIST_LIMIT]:
                    out = store.get(ns, k)
                    if not out:
                        continue
                    v = getattr(out, "value", out) if not isinstance(out, dict) else out
                    if not isinstance(v, dict) or v.get("thread_id") != thread_id:
                        continue
                    task_id = str(k)
                    break
            if task_id is None or v is None:
                continue
            current_status = str(v.get("status") or "").strip().lower()
            authority = get_task_status_authority()
            # Phase-1 灰度：启用单一真源模式时，允许把非终态任务同步到线程真源状态。
            # 未启用时保持历史行为（仅 running -> terminal）。
            if _TASK_SINGLE_SOURCE_ENABLED:
                if authority == "board" and current_status in {"completed", "failed", "cancelled", "paused"} and current_status != normalized_status:
                    # 板状态为外部真源时，记录 thread 投影冲突，不直接覆盖终态。
                    v["status_projection_conflict_count"] = int(v.get("status_projection_conflict_count", 0) or 0) + 1
                    v["status_projection_last_conflict"] = {
                        "from": current_status,
                        "to": normalized_status,
                        "source": "thread",
                        "at": datetime.now(timezone.utc).isoformat(),
                    }
                    with _sync_bid_lock:
                        _store_put_with_retry(store, ns, task_id, v)
                    logger.warning(
                        "task status projection conflict: task_id=%s scope=%s from=%s to=%s authority=%s",
                        task_id,
                        scope,
                        current_status,
                        normalized_status,
                        authority,
                    )
                    continue
                if current_status in {"completed", "failed", "cancelled", "paused"}:
                    continue
            elif current_status != "running":
                continue
            history = _get_thread_task_status_history(thread_id)
            extra = {"task_status_history": history[-30:]} if history else None
            progress_msg = "sync_board_task_by_thread_id"
            progress_val = 100 if normalized_status == "completed" else (int(v.get("progress") or 0) if normalized_status == "failed" else None)
            if project_board_task_status(
                task_id=task_id,
                status=normalized_status,
                scope=scope,
                thread_id=thread_id,
                result=(result[:5000] if result and len(result) > 5000 else result) or "",
                progress=progress_val,
                progress_message=progress_msg,
                source="sync_board_task_by_thread_id",
                only_when_status_in={"running", "awaiting_plan_confirm"},
                extra_updates=extra,
            ):
                logger.info("看板任务已同步: task_id=%s scope=%s status=%s", task_id, scope, normalized_status)
                return
        except Exception as e:
            logger.debug("sync_board_task_by_thread_id %s: %s", scope, e)

