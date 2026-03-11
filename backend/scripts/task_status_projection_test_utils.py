from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from fastapi.testclient import TestClient


def must_status(resp, expected: int, action: str) -> Dict[str, Any]:
    assert resp.status_code == expected, f"{action} 失败: {resp.status_code} {resp.text}"
    body = resp.json()
    assert isinstance(body, dict), f"{action} 响应不是对象: {body}"
    return body


def get_task(client: TestClient, task_id: str, scope: str = "personal") -> Optional[Dict[str, Any]]:
    resp = client.get("/board/tasks", params={"scope": scope})
    body = must_status(resp, 200, "读取任务列表")
    tasks = body.get("tasks") or []
    for row in tasks:
        if str((row or {}).get("id")) == str(task_id):
            return row
    return None


def create_task(client: TestClient, subject: str, description: str, scope: str = "personal") -> str:
    created = client.post(
        "/board/tasks",
        json={"subject": subject, "description": description, "scope": scope, "source_channel": "test"},
    )
    created_body = must_status(created, 200, "创建任务")
    task_id = str(created_body.get("task_id") or "")
    assert task_id, f"task_id 缺失: {created_body}"
    return task_id


def create_human_review_task(
    client: TestClient,
    subject: str,
    description: str,
    scope: str = "personal",
) -> Tuple[str, str, Dict[str, Any]]:
    created = client.post(
        "/board/tasks",
        json={
            "subject": subject,
            "description": description,
            "scope": scope,
            "source_channel": "test",
            "human_checkpoints": [
                {
                    "after_step": "方案草拟",
                    "action": "review",
                    "description": "请评审是否继续",
                    "options": ["approve", "reject", "revise", "delegate", "skip"],
                }
            ],
        },
    )
    body = must_status(created, 200, "创建 human-review 任务")
    task = body.get("task") or {}
    task_id = str(body.get("task_id") or "")
    assert task_id, body
    checkpoints = task.get("human_checkpoints") or []
    checkpoint_id = str((checkpoints[0] or {}).get("checkpoint_id") or "").strip()
    assert checkpoint_id, task
    return task_id, checkpoint_id, task


def submit_human_review_skip(
    client: TestClient,
    task_id: str,
    checkpoint_id: str,
    feedback: str,
    scope: str = "personal",
) -> Dict[str, Any]:
    reviewed = client.post(
        f"/board/tasks/{task_id}/human-review",
        params={"scope": scope},
        json={"checkpoint_id": checkpoint_id, "decision": "skip", "feedback": feedback},
    )
    body = must_status(reviewed, 200, "提交 human-review")
    return body.get("task") or {}


def assert_projection_present(task: Dict[str, Any], action: str, allowed_sources: set[str]) -> None:
    source = str(task.get("status_projection_source") or "")
    assert source in allowed_sources, f"{action} 投影来源异常: {task}"
    assert str(task.get("status_projection_at") or "").strip(), f"{action} 缺少 status_projection_at: {task}"


def assert_projection_absent(task: Dict[str, Any], action: str) -> None:
    assert not str(task.get("status_projection_source") or "").strip(), f"{action} 不应写入 status_projection_source: {task}"
    assert not str(task.get("status_projection_at") or "").strip(), f"{action} 不应写入 status_projection_at: {task}"


def write_json_report(project_root: Path, path: str, payload: Dict[str, Any]) -> str:
    out = Path(path)
    if not out.is_absolute():
        out = project_root / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out.as_posix()
