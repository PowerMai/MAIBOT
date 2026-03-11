"""
关键路径 API 契约测试：/tasks、/board/tasks 等。
保证 Board/Task router 挂载正确且返回约定形状，主流程回归不坏。
"""
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    try:
        from backend.api.app import app
    except ImportError:
        from api.app import app
    return TestClient(app)


def test_get_tasks_returns_ok_and_list(client: TestClient):
    """GET /tasks 应返回 { ok: true, tasks: array }。"""
    resp = client.get("/tasks", params={"limit": 10})
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("ok") is True
    assert "tasks" in data
    assert isinstance(data["tasks"], list)


def test_get_board_tasks_returns_ok_and_list(client: TestClient):
    """GET /board/tasks 应返回 { ok: true, tasks: array } 或 store 不可用时 { ok: false, tasks: [] }。"""
    resp = client.get("/board/tasks", params={"scope": "personal", "limit": 10})
    assert resp.status_code == 200
    data = resp.json()
    assert "ok" in data
    assert "tasks" in data
    assert isinstance(data["tasks"], list)


def test_get_board_capabilities_returns_ok(client: TestClient):
    """GET /board/capabilities 应返回 { ok, profiles, capabilities_summary }。"""
    resp = client.get("/board/capabilities")
    assert resp.status_code == 200
    data = resp.json()
    assert "ok" in data
    assert "profiles" in data
    assert "capabilities_summary" in data
