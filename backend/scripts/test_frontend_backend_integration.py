#!/usr/bin/env python3
"""
前后端联调契约测试：用 TestClient 调用前端实际使用的后端接口，校验状态码与响应结构。
用于 CI/本地确认后端 API 与前端 boardApi/langserveChat/knowledge/skills 等调用一致。
"""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402


def test_health():
    """前端: getApiUrl() + /health (langserveChat.checkHealth)"""
    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200, f"/health: {r.status_code} {r.text}"
    data = r.json()
    assert isinstance(data, dict), data
    assert data.get("status") == "ok", data


def test_board_tasks_list():
    """前端: boardApi.listTasks -> GET /board/tasks?scope=personal"""
    client = TestClient(app)
    r = client.get("/board/tasks", params={"scope": "personal"})
    assert r.status_code == 200, f"/board/tasks: {r.status_code} {r.text}"
    data = r.json()
    assert "tasks" in data, data
    assert isinstance(data["tasks"], list), data
    assert data.get("ok") is True, data


def test_models_list():
    """前端: modelsApi.listModels -> GET /models/list"""
    client = TestClient(app)
    r = client.get("/models/list")
    assert r.status_code == 200, f"/models/list: {r.status_code} {r.text}"
    data = r.json()
    assert isinstance(data, (list, dict)), data


def test_models_diagnostics():
    """模型连接诊断: GET /models/diagnostics"""
    client = TestClient(app)
    r = client.get("/models/diagnostics")
    assert r.status_code == 200, f"/models/diagnostics: {r.status_code} {r.text}"
    data = r.json()
    assert isinstance(data, dict), data
    assert "ok" in data, data
    if data.get("ok"):
        assert "models" in data and "summary" in data, data
        assert data["summary"].get("total", 0) >= 0, data


def test_config_list():
    """前端: configApi.list / useWorkspacePath -> GET /config/list (需内网/TestClient)"""
    client = TestClient(app)
    r = client.get("/config/list")
    assert r.status_code == 200, f"/config/list: {r.status_code} {r.text}"
    data = r.json()
    assert isinstance(data, (list, dict)), data


def test_roles_list():
    """前端: boardApi/rolesApi -> GET /roles/list"""
    client = TestClient(app)
    r = client.get("/roles/list")
    assert r.status_code == 200, f"/roles/list: {r.status_code} {r.text}"
    data = r.json()
    assert isinstance(data, (list, dict)), data


def test_agent_profile():
    """前端: boardApi.getAgentProfile -> GET /agent/profile (需内网/TestClient)"""
    client = TestClient(app)
    r = client.get("/agent/profile")
    assert r.status_code == 200, f"/agent/profile: {r.status_code} {r.text}"
    data = r.json()
    assert isinstance(data, dict), data


def test_skills_profiles():
    """前端: boardApi/skills -> GET /skills/profiles"""
    client = TestClient(app)
    r = client.get("/skills/profiles")
    assert r.status_code == 200, f"/skills/profiles: {r.status_code} {r.text}"
    data = r.json()
    assert isinstance(data, (list, dict)), data


def test_skills_list():
    """前端: skillsAPI.list -> GET /skills/list"""
    client = TestClient(app)
    r = client.get("/skills/list")
    assert r.status_code == 200, f"/skills/list: {r.status_code} {r.text}"
    data = r.json()
    assert isinstance(data, (list, dict)), data


def test_files_list():
    """前端: listUploadedFiles -> GET /files/list (需内网/TestClient)"""
    client = TestClient(app)
    r = client.get("/files/list")
    assert r.status_code == 200, f"/files/list: {r.status_code} {r.text}"
    data = r.json()
    assert "files" in data or isinstance(data, list), data


def test_modes_descriptions():
    """前端: 模式描述 -> GET /modes/descriptions"""
    client = TestClient(app)
    r = client.get("/modes/descriptions")
    assert r.status_code == 200, f"/modes/descriptions: {r.status_code} {r.text}"
    data = r.json()
    assert isinstance(data, dict), data


def test_autonomous_schedule_state():
    """前端: boardApi.getScheduleState -> GET /autonomous/schedule-state (需内网/TestClient)"""
    client = TestClient(app)
    r = client.get("/autonomous/schedule-state")
    assert r.status_code == 200, f"/autonomous/schedule-state: {r.status_code} {r.text}"
    data = r.json()
    assert isinstance(data, dict), data


def test_knowledge_structure():
    """前端: knowledge.getStructure -> GET /knowledge/structure (需内网/TestClient)"""
    client = TestClient(app)
    r = client.get("/knowledge/structure")
    assert r.status_code == 200, f"/knowledge/structure: {r.status_code} {r.text}"
    data = r.json()
    assert isinstance(data, (list, dict)), data


def test_board_metrics_reliability():
    """前端: boardApi.getReliabilityMetrics -> GET /board/metrics/reliability"""
    client = TestClient(app)
    r = client.get("/board/metrics/reliability")
    assert r.status_code == 200, f"/board/metrics/reliability: {r.status_code} {r.text}"
    data = r.json()
    assert isinstance(data, dict), data


def run_all():
    cases = [
        ("/health", test_health),
        ("/board/tasks", test_board_tasks_list),
        ("/models/list", test_models_list),
        ("/models/diagnostics", test_models_diagnostics),
        ("/config/list", test_config_list),
        ("/roles/list", test_roles_list),
        ("/agent/profile", test_agent_profile),
        ("/skills/profiles", test_skills_profiles),
        ("/skills/list", test_skills_list),
        ("/files/list", test_files_list),
        ("/modes/descriptions", test_modes_descriptions),
        ("/autonomous/schedule-state", test_autonomous_schedule_state),
        ("/knowledge/structure", test_knowledge_structure),
        ("/board/metrics/reliability", test_board_metrics_reliability),
    ]
    failed = []
    for name, fn in cases:
        try:
            fn()
            print(f"  ✅ {name}")
        except Exception as e:
            print(f"  ❌ {name}: {e}")
            failed.append((name, e))
    if failed:
        print(f"\n失败: {len(failed)}/{len(cases)}")
        raise SystemExit(1)
    print(f"\n✅ 前后端契约测试通过 ({len(cases)} 项)")


if __name__ == "__main__":
    print("前后端联调契约测试（前端用到的后端接口）\n")
    run_all()
