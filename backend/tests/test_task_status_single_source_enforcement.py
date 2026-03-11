from __future__ import annotations

from copy import deepcopy

from backend.config.store_namespaces import NS_BOARD_PERSONAL, NS_BOARD_RELAY_INDEX
from backend.engine.tasks import task_bidding, task_relay
from backend.tools.base.task_board_tools import get_task_board_tools


class _FakeStore:
    def __init__(self, rows: dict[tuple, dict[str, dict]]):
        self._rows = rows
        self.put_calls: list[tuple[tuple, str, dict]] = []
        self.list_calls: list[tuple] = []

    def list(self, namespace: tuple):
        self.list_calls.append(namespace)
        return list(self._rows.get(namespace, {}).keys())

    def get(self, namespace: tuple, key: str):
        row = deepcopy(self._rows.get(namespace, {}).get(key))
        if row is None:
            return None
        return row

    def put(self, namespace: tuple, key: str, value: dict):
        self.put_calls.append((namespace, key, deepcopy(value)))
        self._rows.setdefault(namespace, {})[key] = deepcopy(value)


def test_task_board_claim_task_returns_error_when_projection_failed(monkeypatch):
    store = _FakeStore(
        {
            NS_BOARD_PERSONAL: {
                "task-1": {"status": "available", "subject": "t1"},
            }
        }
    )
    monkeypatch.setattr(task_bidding, "project_board_task_status", lambda *args, **kwargs: False)

    tools = get_task_board_tools(lambda: store)
    claim_tool = next(t for t in tools if getattr(t, "name", "") == "claim_task")
    result = claim_tool.invoke({"task_id": "task-1", "thread_id": "th-1", "scope": "personal"})

    assert "状态未更新" in result
    assert store.get(NS_BOARD_PERSONAL, "task-1")["status"] == "available"
    assert len(store.put_calls) == 0


def test_task_relay_accept_returns_error_when_projection_failed(monkeypatch):
    store = _FakeStore(
        {
            NS_BOARD_PERSONAL: {
                "task-2": {
                    "relay_id": "relay-1",
                    "status": "available",
                    "subject": "relay task",
                }
            }
        }
    )
    monkeypatch.setattr(task_relay, "_get_store", lambda: store)
    monkeypatch.setattr(task_relay, "project_board_task_status", lambda **kwargs: False)

    result = task_relay.accept_relay("relay-1", accepting_role="default", scope="personal")

    assert result.get("ok") is False
    assert "状态写入失败" in str(result.get("error") or "")
    assert store.get(NS_BOARD_PERSONAL, "task-2")["status"] == "available"
    # 允许回填 relay 索引，但不应写业务任务状态。
    assert all(ns != NS_BOARD_PERSONAL for ns, _, _ in store.put_calls)


def test_task_relay_accept_uses_relay_index_without_board_scan(monkeypatch):
    relay_id = "relay-idx-1"
    store = _FakeStore(
        {
            NS_BOARD_PERSONAL: {
                "task-3": {
                    "relay_id": relay_id,
                    "status": "available",
                    "subject": "indexed relay task",
                }
            },
            NS_BOARD_RELAY_INDEX: {
                f"personal::{relay_id}": {
                    "relay_id": relay_id,
                    "task_id": "task-3",
                    "scope": "personal",
                }
            },
        }
    )
    monkeypatch.setattr(task_relay, "_get_store", lambda: store)
    monkeypatch.setattr(task_relay, "project_board_task_status", lambda **kwargs: True)

    result = task_relay.accept_relay(relay_id, accepting_role="default", scope="personal")

    assert result.get("ok") is True
    assert result.get("task_id") == "task-3"
    assert NS_BOARD_PERSONAL not in store.list_calls
