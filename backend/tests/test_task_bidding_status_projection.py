from __future__ import annotations

from copy import deepcopy

from backend.config.store_namespaces import NS_BOARD_PERSONAL
from backend.engine.tasks import task_bidding


class _FakeStore:
    def __init__(self, rows: dict[tuple, dict[str, dict]]):
        self._rows = rows

    def list(self, namespace: tuple):
        return list(self._rows.get(namespace, {}).keys())

    def get(self, namespace: tuple, key: str):
        row = deepcopy(self._rows.get(namespace, {}).get(key))
        if row is None:
            return None
        return row

    def put(self, namespace: tuple, key: str, value: dict):
        self._rows.setdefault(namespace, {})[key] = deepcopy(value)


def test_sync_board_task_by_thread_id_normalizes_terminal_status_and_sets_progress(monkeypatch):
    store = _FakeStore(
        {
            NS_BOARD_PERSONAL: {
                "task-1": {
                    "status": "running",
                    "thread_id": "thread-1",
                    "progress": 80,
                }
            }
        }
    )
    monkeypatch.setattr(task_bidding, "_get_store", lambda: store)

    task_bidding.sync_board_task_by_thread_id(thread_id="thread-1", status="Completed", result="done")

    updated = store.get(NS_BOARD_PERSONAL, "task-1")
    assert updated["status"] == "completed"
    assert updated["progress"] == 100
    assert updated["result"] == "done"


def test_sync_board_task_by_thread_id_ignores_empty_status(monkeypatch):
    store = _FakeStore(
        {
            NS_BOARD_PERSONAL: {
                "task-2": {
                    "status": "running",
                    "thread_id": "thread-2",
                }
            }
        }
    )
    monkeypatch.setattr(task_bidding, "_get_store", lambda: store)

    task_bidding.sync_board_task_by_thread_id(thread_id="thread-2", status="   ", result="ignored")

    unchanged = store.get(NS_BOARD_PERSONAL, "task-2")
    assert unchanged["status"] == "running"
    assert "result" not in unchanged


def test_list_board_tasks_by_statuses_single_scan_bucket_limit(monkeypatch):
    store = _FakeStore(
        {
            NS_BOARD_PERSONAL: {
                "task-a": {"status": "available", "subject": "a"},
                "task-b": {"status": "available", "subject": "b"},
                "task-c": {"status": "bidding", "subject": "c"},
                "task-d": {"status": "claimed", "subject": "d"},
                "task-e": {"status": "running", "subject": "e"},
            }
        }
    )
    monkeypatch.setattr(task_bidding, "_get_store", lambda: store)

    buckets = task_bidding.list_board_tasks_by_statuses(
        scope="personal",
        statuses={"available", "bidding", "claimed"},
        limit_per_status=1,
        total_scan_limit=10,
    )

    assert set(buckets.keys()) == {"available", "bidding", "claimed"}
    assert len(buckets["available"]) == 1
    assert len(buckets["bidding"]) == 1
    assert len(buckets["claimed"]) == 1
    assert buckets["available"][0]["id"] in {"task-a", "task-b"}
