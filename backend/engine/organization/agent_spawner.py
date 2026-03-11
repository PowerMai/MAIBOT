from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock
from typing import List, Optional


@dataclass
class SpawnRecord:
    ts: str
    parent_agent_id: str
    child_agent_id: str
    role: str
    reason: str
    task_id: Optional[str] = None
    consumed: bool = False


class AgentSpawner:
    """
    Agent 自主孵化器（Phase 2 基础实现）：
    - 记录孵化请求
    - 返回 child_agent_id（由上层窗口/进程管理器真正创建实例）
    """

    def __init__(self):
        self._records: List[SpawnRecord] = []
        self._lock = Lock()

    def request_spawn(self, parent_agent_id: str, role: str, reason: str, task_id: Optional[str] = None) -> str:
        ts = datetime.now(timezone.utc).isoformat()
        child_id = f"{role}-{int(datetime.now().timestamp())}"
        with self._lock:
            self._records.append(
                SpawnRecord(
                    ts=ts,
                    parent_agent_id=parent_agent_id,
                    child_agent_id=child_id,
                    role=role,
                    reason=reason,
                    task_id=(str(task_id).strip() if task_id else None),
                    consumed=False,
                )
            )
            self._records = self._records[-200:]
        return child_id

    def list_records(self) -> List[Dict[str, str]]:
        with self._lock:
            return [r.__dict__.copy() for r in self._records]

    def list_pending(self, limit: int = 20) -> List[Dict[str, str]]:
        with self._lock:
            pending = [r.__dict__.copy() for r in self._records if not r.consumed]
        return pending[: max(1, int(limit))]

    def consume_pending(self, limit: int = 20) -> List[Dict[str, str]]:
        picked: List[Dict[str, str]] = []
        max_n = max(1, int(limit))
        with self._lock:
            for r in self._records:
                if r.consumed:
                    continue
                r.consumed = True
                picked.append(r.__dict__.copy())
                if len(picked) >= max_n:
                    break
        return picked


_GLOBAL_SPAWNER = AgentSpawner()


def get_agent_spawner() -> AgentSpawner:
    return _GLOBAL_SPAWNER

