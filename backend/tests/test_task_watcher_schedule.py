import asyncio
import sys
import types
from datetime import datetime

from backend.engine.tasks import task_watcher
from backend.engine.tasks.task_watcher import _is_due, _parse_iso_ts, _parse_schedule


def test_parse_schedule_daily():
    parsed = _parse_schedule("daily 09:30")
    assert parsed == {"kind": "daily", "time": "09:30"}


def test_parse_schedule_weekly():
    parsed = _parse_schedule("weekly monday 08:15")
    assert parsed["kind"] == "weekly"
    assert parsed["weekday"] == 0
    assert parsed["time"] == "08:15"


def test_parse_schedule_invalid_returns_empty():
    assert _parse_schedule("hourly 09:30") == {}
    assert _parse_schedule("weekly someday 08:15") == {}


def test_is_due_daily_true():
    parsed = {"kind": "daily", "time": "09:30"}
    now = datetime(2026, 1, 1, 9, 31)
    assert _is_due(parsed, now) is True


def test_is_due_invalid_time_or_weekday_returns_false():
    now = datetime(2026, 1, 1, 9, 31)
    assert _is_due({"kind": "daily", "time": "xx:yy"}, now) is False
    assert _is_due({"kind": "weekly", "weekday": "bad", "time": "09:30"}, now) is False


def test_parse_iso_ts_supports_millis_timestamp():
    # 2026-01-01T00:00:00Z
    dt = _parse_iso_ts(1767225600000)
    assert dt is not None
    assert dt.year == 2026
    assert dt.month == 1
    assert dt.day == 1


def test_dispatch_task_once_claimed_returns_already_running_when_register_rejected(monkeypatch):
    fake_bidding = types.SimpleNamespace(
        evaluate_task_fit=None,
        submit_bid=None,
        resolve_bids=None,
    )
    monkeypatch.setitem(sys.modules, "backend.engine.tasks.task_bidding", fake_bidding)

    monkeypatch.setattr(
        task_watcher,
        "_load_board_task",
        lambda scope, task_id: {"id": task_id, "status": "claimed", "claimed_by": "assistant"},
    )

    async def _register_rejected(task_id, agent_id, task_factory):
        return False

    monkeypatch.setattr(task_watcher, "_register_executor_task", _register_rejected)

    out = asyncio.run(task_watcher.dispatch_task_once("task-1"))
    assert out["ok"] is True
    assert out["state"] == "already_running"
    assert out["claimed_by"] == "assistant"


def test_dispatch_task_once_resolved_returns_already_running_when_register_rejected(monkeypatch):
    async def _fit(**kwargs):
        return {"can_handle": True, "confidence": 0.95}

    async def _submit_bid(task_id, role_id, fit, scope="personal"):
        return {"ok": True}

    async def _resolve_bids(task_id, strategy="fair_weighted", scope="personal"):
        return {"ok": True, "claimed_by": "assistant"}

    fake_bidding = types.SimpleNamespace(
        evaluate_task_fit=_fit,
        submit_bid=_submit_bid,
        resolve_bids=_resolve_bids,
    )
    monkeypatch.setitem(sys.modules, "backend.engine.tasks.task_bidding", fake_bidding)

    monkeypatch.setattr(
        task_watcher,
        "_resolve_dispatch_roles",
        lambda preferred_role_id="assistant": ["assistant"],
    )
    monkeypatch.setattr(task_watcher, "_get_role_config", lambda role_id: {})
    monkeypatch.setattr(task_watcher, "_get_role_skills", lambda role_id: [])
    monkeypatch.setattr(task_watcher, "_get_agent_load", lambda role_id, scope="personal": {"running_tasks": 0})
    monkeypatch.setattr(task_watcher, "_claim_task_to_role", lambda scope, task_id, role_id: True)
    monkeypatch.setattr(
        task_watcher,
        "_load_board_task",
        lambda scope, task_id: {"id": task_id, "status": "available", "thread_id": "", "bids": []},
    )

    async def _register_rejected(task_id, agent_id, task_factory):
        return False

    monkeypatch.setattr(task_watcher, "_register_executor_task", _register_rejected)

    out = asyncio.run(task_watcher.dispatch_task_once("task-2"))
    assert out["ok"] is True
    assert out["state"] == "already_running"
    assert out["claimed_by"] == "assistant"


class _InviteStoreWithSearch:
    def __init__(self):
        self.search_calls = 0
        self.list_calls = 0
        self.get_calls = 0

    def search(self, namespace, limit=30):
        self.search_calls += 1
        return [
            {"key": "inv-1", "value": {"status": "received", "subject": "invite1"}},
            {"key": "inv-2", "value": {"status": "retry", "subject": "invite2"}},
        ]

    def list(self, namespace):
        self.list_calls += 1
        return ["inv-1", "inv-2"]

    def get(self, namespace, key):
        self.get_calls += 1
        return {"status": "received", "subject": key}


class _InviteStoreFallbackOnly:
    def __init__(self):
        self.list_calls = 0
        self.get_calls = 0
        self._rows = {
            "inv-10": {"status": "received", "subject": "fallback1"},
            "inv-11": {"status": "retry", "subject": "fallback2"},
        }

    def list(self, namespace):
        self.list_calls += 1
        return list(self._rows.keys())

    def get(self, namespace, key):
        self.get_calls += 1
        return self._rows.get(key)


def test_list_invites_items_prefers_search_path():
    task_watcher._invite_observability.update(
        {
            "scan_search_calls": 0,
            "scan_fallback_calls": 0,
            "scan_search_rows": 0,
            "scan_fallback_rows": 0,
        }
    )
    store = _InviteStoreWithSearch()
    rows = task_watcher._list_invites_items(store, limit=30)

    assert len(rows) == 2
    assert rows[0]["id"] == "inv-1"
    assert rows[1]["id"] == "inv-2"
    assert store.search_calls == 1
    assert store.list_calls == 0
    assert store.get_calls == 0
    assert task_watcher._invite_observability["scan_search_calls"] == 1
    assert task_watcher._invite_observability["scan_search_rows"] == 2
    assert task_watcher._invite_observability["scan_fallback_calls"] == 0


def test_list_invites_items_falls_back_to_list_get():
    task_watcher._invite_observability.update(
        {
            "scan_search_calls": 0,
            "scan_fallback_calls": 0,
            "scan_search_rows": 0,
            "scan_fallback_rows": 0,
        }
    )
    store = _InviteStoreFallbackOnly()
    rows = task_watcher._list_invites_items(store, limit=30)

    assert len(rows) == 2
    assert {r["id"] for r in rows} == {"inv-10", "inv-11"}
    assert store.list_calls == 1
    assert store.get_calls == 2
    assert task_watcher._invite_observability["scan_search_calls"] == 0
    assert task_watcher._invite_observability["scan_fallback_calls"] == 1
    assert task_watcher._invite_observability["scan_fallback_rows"] == 2


def test_reset_invites_observability_resets_counters():
    task_watcher._invite_observability.update(
        {
            "scan_search_calls": 7,
            "scan_fallback_calls": 3,
            "bid_submitted": 5,
            "last_scan_path": "search",
        }
    )
    snapshot = task_watcher.reset_invites_observability()
    assert snapshot["scan_search_calls"] == 0
    assert snapshot["scan_fallback_calls"] == 0
    assert snapshot["bid_submitted"] == 0
    assert snapshot["last_scan_path"] == "reset"
