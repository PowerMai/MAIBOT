#!/usr/bin/env python3
"""
看板契约守卫（负例为主）：
1) 非法状态迁移必须返回 4xx（不能静默成功）
2) 人审 decision 非法值必须返回 400
3) blocked 入参缺失必须返回 4xx
"""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient


PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402
from backend.engine.core.main_graph import cleanup_storage  # noqa: E402
from backend.engine.tasks.task_watcher import stop_watcher_background  # noqa: E402


def run() -> None:
    cleanup_storage()
    client = TestClient(app)
    try:
        # A. completed -> running 非法迁移必须失败
        created_a = client.post(
            "/board/tasks",
            json={"subject": "contract-negative-a", "description": "status transition negative", "scope": "personal"},
        )
        assert created_a.status_code == 200, created_a.text
        task_a = str(created_a.json().get("task_id") or "")
        assert task_a, created_a.json()

        to_running = client.patch(f"/board/tasks/{task_a}", json={"scope": "personal", "status": "running"})
        assert to_running.status_code == 200, to_running.text

        to_completed = client.patch(f"/board/tasks/{task_a}", json={"scope": "personal", "status": "completed"})
        assert to_completed.status_code == 200, to_completed.text

        illegal_after_completed = client.patch(
            f"/board/tasks/{task_a}",
            json={"scope": "personal", "status": "running"},
        )
        assert illegal_after_completed.status_code == 400, (
            f"completed->running 应为 400，实际 {illegal_after_completed.status_code}: {illegal_after_completed.text}"
        )

        # B. awaiting_plan_confirm -> completed 非法迁移必须失败
        created_b = client.post(
            "/board/tasks",
            json={
                "subject": "contract-negative-b",
                "description": "awaiting_plan_confirm transition negative",
                "scope": "personal",
                "require_plan_confirmation": True,
            },
        )
        assert created_b.status_code == 200, created_b.text
        task_b = str(created_b.json().get("task_id") or "")
        assert task_b, created_b.json()
        illegal_from_awaiting = client.patch(
            f"/board/tasks/{task_b}",
            json={"scope": "personal", "status": "completed"},
        )
        assert illegal_from_awaiting.status_code == 400, (
            f"awaiting_plan_confirm->completed 应为 400，实际 {illegal_from_awaiting.status_code}: {illegal_from_awaiting.text}"
        )

        # C. human-review 非法 decision 必须被拒绝
        created_c = client.post(
            "/board/tasks",
            json={
                "subject": "contract-negative-c",
                "description": "human review decision negative",
                "scope": "personal",
                "human_checkpoints": [{"after_step": "plan", "action": "review", "description": "must review"}],
            },
        )
        assert created_c.status_code == 200, created_c.text
        task_c_body = created_c.json().get("task") or {}
        task_c = str(created_c.json().get("task_id") or "")
        checkpoint_id = str(((task_c_body.get("human_checkpoints") or [{}])[0]).get("checkpoint_id") or "")
        assert task_c and checkpoint_id, created_c.json()

        bad_decision = client.post(
            f"/board/tasks/{task_c}/human-review",
            params={"scope": "personal"},
            json={"checkpoint_id": checkpoint_id, "decision": "approve_now", "feedback": "invalid decision"},
        )
        assert bad_decision.status_code == 400, (
            f"非法 decision 应为 400，实际 {bad_decision.status_code}: {bad_decision.text}"
        )

        # D. blocked reason 缺失（schema 校验）应返回 4xx
        bad_blocked = client.post(
            f"/board/tasks/{task_c}/blocked",
            params={"scope": "personal"},
            json={"missing_info": ["x"]},
        )
        assert bad_blocked.status_code in {400, 422}, (
            f"blocked 缺少 reason 应为 4xx，实际 {bad_blocked.status_code}: {bad_blocked.text}"
        )

        print("board contract checks passed")
        print(f"- completed->running rejected: {illegal_after_completed.status_code}")
        print(f"- awaiting_plan_confirm->completed rejected: {illegal_from_awaiting.status_code}")
        print(f"- invalid decision rejected: {bad_decision.status_code}")
    finally:
        client.close()
        stop_watcher_background()
        cleanup_storage()


if __name__ == "__main__":
    run()

