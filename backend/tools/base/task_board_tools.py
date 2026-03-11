"""
任务看板工具 - 基于 LangGraph Store 的共享看板

看板是数据不是 Agent：多个 Thread 通过 Store 读写同一 namespace 协调，无需指挥 Thread。
多级命名空间: ("board", "personal") | ("board", "org") | ("board", "public")
"""

import logging
import uuid
from typing import Callable, Optional, Any
from datetime import datetime, timezone
from langchain_core.tools import tool
from backend.config.store_namespaces import (
    NS_TASK_BOARD_LEGACY,
    NS_BOARD_PERSONAL,
    NS_BOARD_ORG,
    NS_BOARD_PUBLIC,
)

logger = logging.getLogger(__name__)

# 多级看板命名空间（Phase 1 主要用 personal）
TASK_BOARD_NS = NS_TASK_BOARD_LEGACY  # 兼容旧工具
BOARD_NS_PERSONAL = NS_BOARD_PERSONAL
BOARD_NS_ORG = NS_BOARD_ORG
BOARD_NS_PUBLIC = NS_BOARD_PUBLIC


def _ns_for_scope(scope: str) -> tuple:
    if scope == "org":
        return BOARD_NS_ORG
    if scope == "public":
        return BOARD_NS_PUBLIC
    return BOARD_NS_PERSONAL

# 独立运行时由 main_graph 设置，LangGraph API 模式下不设置则看板不可用
_store_getter: Optional[Callable[[], Any]] = None


def set_store_getter(getter: Optional[Callable[[], Any]] = None) -> None:
    """由 main_graph 在独立运行时设置，使看板工具能拿到 Store。"""
    global _store_getter
    _store_getter = getter


def _get_store(get_store_fn: Optional[Callable[[], Any]] = None):
    """获取 Store 实例；优先使用传入的 getter，否则用模块级 _store_getter。"""
    fn = get_store_fn if get_store_fn is not None else _store_getter
    if fn is None:
        return None
    try:
        return fn()
    except Exception as e:
        logger.warning("task_board: get_store failed: %s", e)
        return None


def get_task_board_tools(get_store_fn: Optional[Callable[[], Any]] = None):
    """
    返回任务看板三件套：list_board_tasks, claim_task, update_task。
    需传入 get_store_fn（如 deep_agent.get_store），否则工具执行时提示看板不可用。
    """
    def _store():
        return _get_store(get_store_fn)

    def _list_in_ns(store, ns: tuple, status: Optional[str] = None) -> list:
        """从 store 的 namespace 列出任务，按 status 过滤。pending 与 available 均视为待处理。"""
        items = []
        if not hasattr(store, "list"):
            return items
        try:
            allowed = None
            if status is not None:
                allowed = {status}
                if status == "pending":
                    allowed = {"pending", "available"}
            keys = list(store.list(ns))
            for k in keys:
                out = store.get(ns, k)
                if not out:
                    continue
                v = getattr(out, "value", out) if not isinstance(out, dict) else out
                if isinstance(v, dict):
                    if allowed is None or v.get("status") in allowed:
                        items.append((k, v))
        except Exception as e:
            logger.debug("_list_in_ns 异常: %s", e)
        return items

    @tool
    def list_board_tasks(status: str = "pending", scope: str = "personal") -> str:
        """查看任务看板上的任务。

        Use when:
        - 需要查看当前可领取/进行中/已完成任务。
        - 多线程协作前需要同步看板状态。

        Avoid when:
        - 只关心某个单一任务详情（优先 get_task_details 或直接查询 task_id）。
        - 当前环境未接入 Store（会返回不可用提示）。

        Strategy:
        - 先看 pending，再看 running，最后看 failed，形成处理队列。
        
        Args:
            status: pending | running | completed | failed
            scope: personal | org | public
        Returns:
            任务列表的文本摘要
        """
        store = _store()
        if store is None:
            return "任务看板不可用（当前运行环境无 Store）。"
        try:
            ns = _ns_for_scope(scope)
            items = _list_in_ns(store, ns, status)
            # 兼容旧 namespace
            if scope == "personal" and not items:
                items = _list_in_ns(store, TASK_BOARD_NS, status)
            if not items:
                return f"暂无状态为 {status} 的任务。"
            lines = []
            for i, (tid, v) in enumerate(items, 1):
                task_id = v.get("task_id") or tid
                subj = v.get("subject", "")
                pri = v.get("priority", 3)
                assignee = v.get("assigned_to", "")
                parts = [f"{i}. [{task_id}] {subj} (优先级:{pri}"]
                if assignee:
                    parts.append(f", 认领:{assignee}")
                progress = v.get("progress")
                if progress is not None and isinstance(progress, (int, float)):
                    parts.append(f", 进度:{int(progress)}%")
                req = v.get("required_skills")
                if req and isinstance(req, list) and len(req) > 0:
                    parts.append(", 需技能:" + ",".join(str(s) for s in req[:5]))
                parts.append(")")
                lines.append("".join(parts))
            return "\n".join(lines)
        except Exception as e:
            logger.exception("list_board_tasks failed")
            return f"读取看板失败: {e}"

    def _get_task_value(store, ns: tuple, task_id: str) -> Optional[dict]:
        out = store.get(ns, task_id)
        if not out:
            return None
        if hasattr(out, "__iter__") and not isinstance(out, (str, bytes)):
            out = list(out)
        if isinstance(out, list) and out:
            item = out[0]
            val = getattr(item, "value", item) if not isinstance(item, dict) else item
        else:
            val = getattr(out, "value", out) if not isinstance(out, dict) else out
        if isinstance(val, dict):
            return dict(val)
        return {"subject": str(val), "status": "pending", "priority": 3}

    @tool
    def claim_task(task_id: str, thread_id: str = "", scope: str = "personal") -> str:
        """认领一个任务（将状态设为 running 并记录认领者）。

        Use when:
        - 准备开始执行某任务，需锁定归属避免并发冲突。
        - 从 pending/available/failed 重新拉起任务。

        Avoid when:
        - 任务已是 running/completed 且不需要接管。
        - task_id 不存在或 scope 选择错误。

        Strategy:
        - 认领后立即 report_progress，降低协作不透明。
        
        Args:
            task_id: 任务 ID（看板中的 key）
            thread_id: 认领者（当前 thread_id），可选
            scope: personal | org | public
        Returns:
            操作结果说明
        """
        store = _store()
        if store is None:
            return "任务看板不可用（当前运行环境无 Store）。"
        try:
            ns = _ns_for_scope(scope)
            val = _get_task_value(store, ns, task_id)
            if val is None and scope == "personal":
                val = _get_task_value(store, TASK_BOARD_NS, task_id)
                ns = TASK_BOARD_NS
            if val is None:
                return f"任务 {task_id} 不存在。"
            current = val.get("status", "available")
            if current not in ("available", "pending", "blocked", "awaiting_plan_confirm", "waiting_human", "paused"):
                return f"任务 {task_id} 当前状态为 {current}，仅待处理/阻塞/待确认/暂停等可恢复状态可认领。"
            try:
                from backend.engine.tasks.task_bidding import project_board_task_status

                projected = project_board_task_status(
                    task_id=task_id,
                    status="running",
                    scope=scope,
                    thread_id=(str(thread_id).strip() or str(val.get("thread_id") or "").strip() or None),
                    progress=(int(val.get("progress")) if isinstance(val.get("progress"), (int, float)) else None),
                    progress_message=str(val.get("progress_message") or ""),
                    dispatch_state=str(val.get("dispatch_state") or "") or None,
                    claimed_by=(str(val.get("claimed_by") or "") or None),
                    source="task_board_tools_claim",
                    extra_updates={"assigned_to": thread_id or "current"},
                )
                if not projected:
                    return f"认领失败：任务 {task_id} 状态未更新（可能被并发修改）。"
            except Exception:
                logger.exception("claim_task status projection failed")
                return f"认领失败：任务 {task_id} 状态写入异常。"
            return f"已认领任务 {task_id}。"
        except Exception as e:
            logger.exception("claim_task failed")
            return f"认领失败: {e}"

    @tool
    def update_task(task_id: str, status: str, result: str = "", scope: str = "personal") -> str:
        """更新任务状态/结果。

        Use when:
        - 任务阶段推进（running/completed/failed/cancelled）。
        - 需要回写结果摘要供后续线程复用。

        Avoid when:
        - 尚未开始执行就直接 completed（会污染看板质量）。
        - 不确定状态流转是否合法。

        Strategy:
        - 关键变更同步写 result，便于审计与回溯。
        
        Args:
            task_id: 任务 ID
            status: running | blocked | waiting_human | completed | failed | cancelled
            result: 完成时的结果摘要（可选）
            scope: personal | org | public
        Returns:
            操作结果说明
        """
        store = _store()
        if store is None:
            return "任务看板不可用（当前运行环境无 Store）。"
        try:
            ns = _ns_for_scope(scope)
            val = _get_task_value(store, ns, task_id)
            if val is None and scope == "personal":
                val = _get_task_value(store, TASK_BOARD_NS, task_id)
                ns = TASK_BOARD_NS
            if val is None:
                return f"任务 {task_id} 不存在。"
            current = val.get("status", "available")
            if current == "completed" and status == "running":
                return f"任务 {task_id} 已完成，不能直接改为运行中。"
            try:
                from backend.engine.tasks.task_bidding import project_board_task_status

                projected = project_board_task_status(
                    task_id=task_id,
                    status=str(status or ""),
                    scope=scope,
                    thread_id=str(val.get("thread_id") or "") or None,
                    result=str(result or "") if result else None,
                    progress=(int(val.get("progress")) if isinstance(val.get("progress"), (int, float)) else None),
                    progress_message=str(val.get("progress_message") or ""),
                    dispatch_state=str(val.get("dispatch_state") or "") or None,
                    claimed_by=(str(val.get("claimed_by") or "") or None),
                    source="task_board_tools_update",
                )
                if not projected:
                    return f"更新失败：任务 {task_id} 状态未更新（可能被并发修改）。"
            except Exception:
                logger.exception("update_task status projection failed")
                return f"更新失败：任务 {task_id} 状态写入异常。"
            return f"任务 {task_id} 已更新为 {status}。"
        except Exception as e:
            logger.exception("update_task failed")
            return f"更新失败: {e}"

    @tool
    def report_blocked(
        task_id: str,
        reason: str,
        missing_info: Optional[list] = None,
        scope: str = "personal",
    ) -> str:
        """上报任务阻塞原因与缺失信息。

        Use when:
        - 任务因信息不足、权限不足、依赖未满足无法继续推进。

        Strategy:
        - 将状态更新为 blocked，并明确最少补充信息清单。

        Args:
            task_id: 任务 ID
            reason: 阻塞原因（简短明确）
            missing_info: 缺失信息列表（可选）
            scope: personal | org | public
        Returns:
            操作结果
        """
        store = _store()
        if store is None:
            return "任务看板不可用（当前运行环境无 Store）。"
        try:
            ns = _ns_for_scope(scope)
            val = _get_task_value(store, ns, task_id)
            if val is None and scope == "personal":
                val = _get_task_value(store, TASK_BOARD_NS, task_id)
                ns = TASK_BOARD_NS
            if val is None:
                return f"任务 {task_id} 不存在。"
            missing = [str(x).strip()[:300] for x in (missing_info or []) if str(x).strip()]
            val["status"] = "blocked"
            val["blocked_reason"] = str(reason or "").strip()[:500]
            val["missing_information"] = missing
            val["progress_message"] = (
                f"任务阻塞：{val['blocked_reason']}" if val["blocked_reason"] else "任务阻塞，等待补充信息"
            )
            try:
                from backend.engine.tasks.task_bidding import project_board_task_status

                projected = project_board_task_status(
                    task_id=task_id,
                    status="blocked",
                    scope=scope,
                    thread_id=str(val.get("thread_id") or "") or None,
                    progress=(int(val.get("progress")) if isinstance(val.get("progress"), (int, float)) else None),
                    progress_message=str(val.get("progress_message") or ""),
                    dispatch_state=str(val.get("dispatch_state") or "") or None,
                    claimed_by=(str(val.get("claimed_by") or "") or None),
                    source="task_board_tools_blocked",
                    extra_updates={
                        "blocked_reason": val["blocked_reason"],
                        "missing_information": missing,
                        "blocked_at": datetime.now(timezone.utc).isoformat(),
                        "recovered_at": None,
                    },
                )
                if not projected:
                    return f"上报阻塞失败：任务 {task_id} 状态未更新（可能被并发修改）。"
            except Exception:
                logger.exception("report_blocked status projection failed")
                return f"上报阻塞失败：任务 {task_id} 状态写入异常。"
            return f"已上报任务 {task_id} 阻塞。"
        except Exception as e:
            logger.exception("report_blocked failed")
            return f"上报阻塞失败: {e}"

    @tool
    def report_artifacts(
        task_id: str,
        deliverables: Optional[list] = None,
        changed_files: Optional[list] = None,
        rollback_hint: str = "",
        scope: str = "personal",
    ) -> str:
        """上报任务成果物、变更文件和回滚提示。

        Use when:
        - 任务完成或阶段完成，需要沉淀可交付物与可追溯信息。

        Args:
            task_id: 任务 ID
            deliverables: 产出列表（文档/报告/代码等）
            changed_files: 变更文件路径列表
            rollback_hint: 回滚建议
            scope: personal | org | public
        Returns:
            操作结果
        """
        store = _store()
        if store is None:
            return "任务看板不可用（当前运行环境无 Store）。"
        try:
            ns = _ns_for_scope(scope)
            val = _get_task_value(store, ns, task_id)
            if val is None and scope == "personal":
                val = _get_task_value(store, TASK_BOARD_NS, task_id)
                ns = TASK_BOARD_NS
            if val is None:
                return f"任务 {task_id} 不存在。"
            if deliverables is not None:
                val["deliverables"] = [str(x).strip() for x in deliverables if str(x).strip()]
            if changed_files is not None:
                val["changed_files"] = [str(x).strip() for x in changed_files if str(x).strip()]
            val["rollback_hint"] = str(rollback_hint or "").strip()
            if "state_version" in val and isinstance(val.get("state_version"), (int, float)):
                val["state_version"] = int(val["state_version"]) + 1
            val["updated_at"] = datetime.now(timezone.utc).isoformat()
            store.put(ns, task_id, val)
            return f"已记录任务 {task_id} 成果物信息。"
        except Exception as e:
            logger.exception("report_artifacts failed")
            return f"上报成果物失败: {e}"

    @tool
    def create_task(
        subject: str,
        description: str = "",
        scope: str = "personal",
        priority: int = 3,
        source_channel: str = "local",
        cost_tier: str = "medium",
        splittable: bool = False,
        total_units: Optional[int] = None,
        unit_label: Optional[str] = None,
        required_skills: Optional[list] = None,
        human_checkpoints: Optional[list] = None,
    ) -> str:
        """在看板上创建新任务（默认个人看板）。

        Use when:
        - 需要把用户目标拆成可分配、可追踪任务。
        - 需要跨线程共享任务上下文和优先级。

        Avoid when:
        - 只是临时一步操作，不值得进入看板。
        - subject 过于模糊无法执行。

        Strategy:
        - subject 写“动词+对象+约束”，并填 required_skills 提升路由准确率。
        
        Args:
            subject: 任务标题
            description: 任务描述（可选）
            scope: personal | org | public
            priority: 1-5，默认 3
            source_channel: local | openclaw | wechat
            cost_tier: high | medium | low，用于 LLM 等级路由
            splittable: 是否可拆分
            total_units: 总工作量（可拆分时）
            unit_label: 单位（条/页/份）
            required_skills: 所需 Skills 列表
            human_checkpoints: 人类检查点 [{after_step, action, description}]
        Returns:
            创建结果，含 task_id
        """
        store = _store()
        if store is None:
            return "任务看板不可用（当前运行环境无 Store）。"
        try:
            ns = _ns_for_scope(scope)
            task_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc).isoformat()
            val = {
                "task_id": task_id,
                "subject": subject,
                "description": description or "",
                "status": "available",
                "priority": max(1, min(5, priority)),
                "scope": scope,
                "source_channel": source_channel or "local",
                "cost_tier": cost_tier or "medium",
                "created_at": now,
                "updated_at": now,
                "splittable": bool(splittable),
                "total_units": total_units,
                "claimed_units": 0,
                "unit_label": unit_label,
                "parent_task_id": None,
                "subtask_ids": [],
                "required_skills": required_skills or [],
                "human_checkpoints": human_checkpoints or [],
                "progress": 0,
                "progress_message": None,
                "external_task_id": None,
                "pricing": None,
                "changed_files": [],
                "rollback_hint": "",
                "blocked_reason": None,
                "missing_information": [],
            }
            store.put(ns, task_id, val)
            return f"已创建任务 {task_id}：{subject}"
        except Exception as e:
            logger.exception("create_task failed")
            return f"创建失败: {e}"

    @tool
    def report_progress(task_id: str, progress: int, message: str = "", scope: str = "personal") -> str:
        """报告任务进度（0-100 + 文字说明）。

        Use when:
        - 长任务执行中，需要周期性更新进度。
        - 需要让其他线程了解当前阻塞点和完成度。

        Avoid when:
        - 任务已 completed/cancelled 且无需进一步更新。
        - 高频无意义刷新（会产生噪声）。

        Strategy:
        - 进度更新与阶段里程碑绑定（如 20/50/80/100）。
        
        Args:
            task_id: 任务 ID
            progress: 进度百分比 0-100
            message: 进度说明（可选）
            scope: personal | org | public
        Returns:
            操作结果
        """
        store = _store()
        if store is None:
            return "任务看板不可用（当前运行环境无 Store）。"
        try:
            ns = _ns_for_scope(scope)
            val = _get_task_value(store, ns, task_id)
            if val is None and scope == "personal":
                val = _get_task_value(store, TASK_BOARD_NS, task_id)
                ns = TASK_BOARD_NS
            if val is None:
                return f"任务 {task_id} 不存在。"
            val["progress"] = max(0, min(100, progress))
            val["progress_message"] = (message or "").strip() or None
            val["updated_at"] = datetime.now(timezone.utc).isoformat()
            store.put(ns, task_id, val)
            return f"已更新任务 {task_id} 进度为 {val['progress']}%。"
        except Exception as e:
            logger.exception("report_progress failed")
            return f"报告进度失败: {e}"

    @tool
    def publish_subtask(
        parent_task_id: str,
        subject: str,
        description: str = "",
        scope: str = "personal",
        priority: Optional[int] = None,
    ) -> str:
        """将子任务发回公告板（关联父任务）。

        Use when:
        - 父任务可拆分，需要并行处理子任务。
        - 希望保留父子关系进行后续汇总。

        Avoid when:
        - 父任务本身很小，拆分会增加协作成本。
        - 父任务尚未定义清晰边界。

        Strategy:
        - 子任务标题保持互斥，避免与父任务重复描述。
        
        Args:
            parent_task_id: 父任务 ID
            subject: 子任务标题
            description: 子任务描述（可选）
            scope: personal | org | public
            priority: 优先级（可选，默认与父任务一致）
        Returns:
            创建结果，含子任务 task_id
        """
        store = _store()
        if store is None:
            return "任务看板不可用（当前运行环境无 Store）。"
        try:
            ns = _ns_for_scope(scope)
            parent_val = _get_task_value(store, ns, parent_task_id)
            if parent_val is None and scope == "personal":
                parent_val = _get_task_value(store, TASK_BOARD_NS, parent_task_id)
            if parent_val is None:
                return f"父任务 {parent_task_id} 不存在。"
            sub_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc).isoformat()
            sub_val = {
                "task_id": sub_id,
                "subject": subject,
                "description": description or "",
                "status": "available",
                "priority": priority if priority is not None else parent_val.get("priority", 3),
                "scope": scope,
                "source_channel": parent_val.get("source_channel", "local"),
                "cost_tier": parent_val.get("cost_tier", "medium"),
                "created_at": now,
                "updated_at": now,
                "splittable": False,
                "total_units": None,
                "claimed_units": 0,
                "unit_label": None,
                "parent_task_id": parent_task_id,
                "subtask_ids": [],
                "required_skills": parent_val.get("required_skills", []),
                "human_checkpoints": [],
                "progress": 0,
                "progress_message": None,
                "external_task_id": None,
                "pricing": None,
                "changed_files": [],
                "rollback_hint": "",
                "blocked_reason": None,
                "missing_information": [],
            }
            store.put(ns, sub_id, sub_val)
            sub_ids = parent_val.get("subtask_ids") or []
            if sub_id not in sub_ids:
                sub_ids.append(sub_id)
                parent_val["subtask_ids"] = sub_ids
                parent_val["updated_at"] = now
                store.put(ns, parent_task_id, parent_val)
            return f"已发布子任务 {sub_id}：{subject}"
        except Exception as e:
            logger.exception("publish_subtask failed")
            return f"发布子任务失败: {e}"

    return [
        list_board_tasks,
        claim_task,
        update_task,
        create_task,
        report_progress,
        report_blocked,
        report_artifacts,
        publish_subtask,
    ]


__all__ = [
    "get_task_board_tools",
    "set_store_getter",
    "TASK_BOARD_NS",
    "BOARD_NS_PERSONAL",
    "BOARD_NS_ORG",
    "BOARD_NS_PUBLIC",
]
