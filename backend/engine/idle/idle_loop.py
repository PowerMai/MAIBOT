from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from backend.engine.autonomy.levels import get_autonomy_settings
from backend.engine.idle.cost_tracker import CostTracker
from backend.engine.idle.goal_manager import GoalManager
from backend.engine.idle.journal import Journal
from backend.tools.base.knowledge_learning import scan_and_learn
from backend.tools.base.paths import get_workspace_root

logger = logging.getLogger(__name__)

# 工作区建议待推送缓存：workspace_path -> 建议摘要（由 crystallization-suggestion 端点统一返回，CrystallizationToast 展示）
_copilot_pending: dict[str, str] = {}


def get_and_clear_copilot_suggestion(workspace_id: str) -> Optional[str]:
    """获取并清除该工作区的待推送 co-pilot 建议。"""
    key = (workspace_id or "").strip() or "default"
    return _copilot_pending.pop(key, None)


def set_copilot_suggestion(workspace_id: str, message: str) -> None:
    """设置待推送的 co-pilot 建议（由 idle 循环在检测到上下文变化时调用）。"""
    key = (workspace_id or "").strip() or "default"
    _copilot_pending[key] = message


@dataclass
class IdleCycleResult:
    ok: bool
    goal: str
    message: str


async def run_idle_cycle_once() -> IdleCycleResult:
    """
    执行一次 ELI(Explore-Learn-Improve) 循环的最小闭环：
    读取目标 -> 记录日志 -> 记录成本。
    scan_and_learn 为纯读操作，不受自治等级限制，始终执行；co-pilot 建议仅在 allow_idle_loop 时执行。
    """
    settings = get_autonomy_settings()
    allow_full_idle = bool(settings.get("allow_idle_loop", False))

    goals = GoalManager()
    journal = Journal()
    costs = CostTracker()
    goal = goals.next_goal() if allow_full_idle else "learn_only"

    journal.append("Idle-Explore", f"Selected goal: {goal}")
    try:
        learn_result = await asyncio.wait_for(asyncio.to_thread(scan_and_learn), timeout=120.0)
    except asyncio.TimeoutError:
        learn_result = "timeout"
    journal.append("Idle-Learn", f"scan_and_learn completed: {learn_result}")
    costs.record("idle_cycle", token_cost=0.0, usd_cost=0.0, metadata={"goal": goal})

    # 用户上下文变化感知分支：仅在允许完整 idle 时执行（L2/L3 或显式开启）
    if allow_full_idle:
        try:
            if bool(settings.get("allow_copilot_suggestions", False)):
                ws_root = get_workspace_root()
                if ws_root and ws_root.exists():
                    if await asyncio.to_thread(_recent_workspace_changes, ws_root, 600):
                        set_copilot_suggestion("default", "工作区有近期变更，可在对话中描述当前任务获取建议。")
                        journal.append("Idle-Co-pilot", "Workspace context changed; co-pilot suggestion pending.")
        except Exception as e:
            logger.debug("Idle co-pilot branch: %s", e)

    journal.append("Idle-Improve", "Recorded cost and finished one idle cycle.")
    return IdleCycleResult(ok=True, goal=goal, message="idle cycle completed")


def _recent_workspace_changes(workspace_root: Path, max_age_sec: int = 600) -> bool:
    """检测工作区根下是否有近期（max_age_sec 秒内）修改过的文件。"""
    try:
        if not workspace_root.exists():
            return False
        cutoff = time.time() - max_age_sec
        count = 0
        for p in workspace_root.iterdir():
            if count >= 20:
                break
            try:
                if p.is_file():
                    if p.stat().st_mtime >= cutoff:
                        return True
                    count += 1
                elif p.is_dir() and p.name not in (".git", "node_modules", "__pycache__"):
                    for q in list(p.iterdir())[:30]:
                        if q.is_file() and q.stat().st_mtime >= cutoff:
                            return True
                        count += 1
                        if count >= 20:
                            break
            except OSError:
                continue
    except Exception:
        pass
    return False


class IdleLoopEngine:
    """后台空闲循环引擎（定时触发 run_idle_cycle_once）。"""

    def __init__(self, interval_seconds: int = 300):
        self.interval_seconds = max(30, int(interval_seconds))
        self._task: Optional[asyncio.Task] = None
        self._fail_count = 0
        self._max_backoff = 300

    async def _loop(self) -> None:
        while True:
            try:
                delay = min(
                    self.interval_seconds * (2**self._fail_count),
                    self._max_backoff,
                )
                await asyncio.sleep(delay)
                result = await run_idle_cycle_once()
                if result.ok:
                    self._fail_count = 0
                    logger.info("Idle cycle done: %s", result.goal)
            except asyncio.CancelledError:
                break
            except Exception as e:
                self._fail_count = min(self._fail_count + 1, 10)
                logger.exception("Idle loop error: %s", e)

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        try:
            loop = asyncio.get_running_loop()
            self._task = loop.create_task(self._loop())
        except RuntimeError:
            logger.debug("IdleLoopEngine.start skipped: no running event loop")

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

