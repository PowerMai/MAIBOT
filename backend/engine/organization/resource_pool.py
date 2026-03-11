from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from typing import Dict


@dataclass
class ResourceQuota:
    cpu_slots: int = 1
    model_calls_per_hour: int = 100
    usd_budget_daily: float = 0.0


class ResourcePool:
    """
    组织共享资源池（Phase 2 基础实现）：
    - 记录每个 agent 的资源配额
    - 支持读取与更新（线程安全）
    """

    def __init__(self):
        self._lock = Lock()
        self._quotas: Dict[str, ResourceQuota] = {}

    def get_quota(self, agent_id: str) -> ResourceQuota:
        with self._lock:
            return self._quotas.get(agent_id, ResourceQuota())

    def set_quota(self, agent_id: str, quota: ResourceQuota) -> None:
        with self._lock:
            self._quotas[agent_id] = quota

    def to_dict(self) -> Dict[str, dict]:
        with self._lock:
            return {k: v.__dict__.copy() for k, v in self._quotas.items()}


_GLOBAL_RESOURCE_POOL = ResourcePool()


def get_resource_pool() -> ResourcePool:
    return _GLOBAL_RESOURCE_POOL

