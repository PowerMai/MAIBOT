"""核心引擎验收：accept-bid 并发测试（同任务多请求仅 1 个成功）。"""
from __future__ import annotations

import threading
from copy import deepcopy

from backend.config.store_namespaces import NS_BOARD_PERSONAL
from backend.engine.tasks import task_bidding


class _FakeStore:
    def __init__(self, rows: dict):
        self._rows = rows
        self._lock = threading.Lock()

    def list(self, namespace: tuple):
        return list(self._rows.get(namespace, {}).keys())

    def get(self, namespace: tuple, key: str):
        with self._lock:
            row = deepcopy(self._rows.get(namespace, {}).get(key))
        if row is None:
            return None
        return row

    def put(self, namespace: tuple, key: str, value: dict):
        with self._lock:
            self._rows.setdefault(namespace, {})[key] = deepcopy(value)


def test_project_board_task_status_concurrent_only_one_succeeds(monkeypatch):
    """同任务多线程并发 project_board_task_status(available->claimed)，仅一个返回 True。"""
    store = _FakeStore(
        {
            NS_BOARD_PERSONAL: {
                "task-race": {
                    "id": "task-race",
                    "status": "available",
                    "subject": "race",
                    "claimed_by": "",
                }
            }
        }
    )
    monkeypatch.setattr(task_bidding, "_get_store", lambda: store)

    results = []
    errors = []

    def run_accept():
        try:
            # 初始认领：仅当状态为 available/bidding/pending 时可认领，已 claimed 后不再接受（与 accept-bid 竞态语义一致）
            ok = task_bidding.project_board_task_status(
                "task-race",
                "claimed",
                "personal",
                claimed_by="agent-1",
                source="test",
                only_when_status_in={"available", "bidding", "pending"},
            )
            results.append(ok)
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=run_accept) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    assert sum(results) == 1, f"expected exactly one True, got {results}"
    assert store.get(NS_BOARD_PERSONAL, "task-race")["status"] == "claimed"
    assert store.get(NS_BOARD_PERSONAL, "task-race")["claimed_by"] == "agent-1"


def test_blocked_single_source_projection_failure_no_write(monkeypatch):
    """单源模式下 blocked 投影失败时不写入 store（回归：无「投影失败但写入成功」）。"""
    from backend.config.store_namespaces import NS_BOARD_PERSONAL

    store = _FakeStore(
        {
            NS_BOARD_PERSONAL: {
                "task-done": {
                    "id": "task-done",
                    "status": "completed",
                    "subject": "done",
                    "claimed_by": "agent-1",
                }
            }
        }
    )
    monkeypatch.setattr(task_bidding, "_get_store", lambda: store)
    monkeypatch.setattr(task_bidding, "is_task_single_source_enabled", lambda: True)

    ok = task_bidding.project_board_task_status(
        "task-done",
        "blocked",
        "personal",
        source="blocked_api",
        extra_updates={"blocked_reason": "test", "blocked_at": "2026-01-01T00:00:00Z"},
    )
    assert ok is False
    assert store.get(NS_BOARD_PERSONAL, "task-done")["status"] == "completed"
