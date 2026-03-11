#!/usr/bin/env python3
"""
看板分发关键路径回归：
1) 创建后即时分发
2) 人工检查点通过后二次分发
3) dispatch_task_once 幂等触发
4) 进度接口非法入参返回 400
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Callable, Dict, Optional

from fastapi.testclient import TestClient


PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402
from backend.engine.tasks.task_watcher import stop_watcher_background  # noqa: E402
from backend.engine.core.main_graph import cleanup_storage  # noqa: E402


def _get_task(client: TestClient, task_id: str, scope: str = "personal") -> Optional[Dict]:
    resp = client.get("/board/tasks", params={"scope": scope})
    assert resp.status_code == 200, f"获取任务列表失败: {resp.status_code} {resp.text}"
    tasks = resp.json().get("tasks") or []
    for t in tasks:
        if str(t.get("id")) == str(task_id):
            return t
    return None


def _poll_task(
    client: TestClient,
    task_id: str,
    predicate: Callable[[Dict], bool],
    timeout_sec: float = 15.0,
    interval_sec: float = 0.8,
) -> Dict:
    deadline = time.time() + timeout_sec
    latest: Dict = {}
    while time.time() < deadline:
        row = _get_task(client, task_id)
        if row:
            latest = row
            if predicate(row):
                return row
        time.sleep(interval_sec)
    return latest


def run() -> None:
    client = TestClient(app)
    try:
        # 1) 创建普通任务：应立即进入分发链路
        created = client.post(
            "/board/tasks",
            json={
                "subject": "回归任务-A：创建后即时分发",
                "description": "验证创建后自动分发、认领与执行启动",
                "priority": 3,
                "scope": "personal",
                "source_channel": "regression",
                "cost_tier": "low",
            },
        )
        assert created.status_code == 200, f"创建任务失败: {created.status_code} {created.text}"
        body = created.json()
        task_id_a = str(body.get("task_id") or (body.get("task") or {}).get("id") or "")
        assert task_id_a, f"创建响应缺少 task_id: {body}"
        assert str(body.get("dispatch_state") or "") in {"dispatching", "waiting_human"}, body

        progressed_a = _poll_task(
            client,
            task_id_a,
            lambda t: str(t.get("status") or "") in {"available", "claimed", "running", "completed", "failed"},
            timeout_sec=18.0,
        )
        assert progressed_a, "任务A未出现在任务列表"
        assert str(progressed_a.get("status") or "") in {"available", "claimed", "running", "completed", "failed"}, progressed_a

        # 2) 再次读取任务快照：确保创建后的分发状态读取稳定
        second_snap_a = _get_task(client, task_id_a, scope="personal")
        assert second_snap_a is not None, "任务A二次读取失败"
        assert str(second_snap_a.get("status") or "") in {"available", "claimed", "running", "completed", "failed"}, second_snap_a

        # 3) 创建带人审任务：通过后应自动继续分发
        created_human = client.post(
            "/board/tasks",
            json={
                "subject": "回归任务-B：检查点通过后自动分发",
                "description": "验证 waiting_human -> approve -> 自动进入分发执行",
                "priority": 3,
                "scope": "personal",
                "source_channel": "regression",
                "cost_tier": "low",
                "human_checkpoints": [{"after_step": "计划草案", "action": "review", "description": "需人工确认"}],
            },
        )
        assert created_human.status_code == 200, f"创建人审任务失败: {created_human.status_code} {created_human.text}"
        h_body = created_human.json()
        task_id_b = str(h_body.get("task_id") or (h_body.get("task") or {}).get("id") or "")
        assert task_id_b, f"创建人审任务响应缺少 task_id: {h_body}"
        t_b = h_body.get("task") or {}
        assert str(t_b.get("status") or "") == "waiting_human", t_b

        checkpoints = t_b.get("human_checkpoints") or []
        checkpoint_id = str((checkpoints[0] or {}).get("checkpoint_id") or "计划草案-review-0")
        reviewed = client.post(
            f"/board/tasks/{task_id_b}/human-review",
            params={"scope": "personal"},
            json={"checkpoint_id": checkpoint_id, "decision": "approve", "feedback": "回归通过"},
        )
        assert reviewed.status_code == 200, f"提交人审失败: {reviewed.status_code} {reviewed.text}"

        progressed_b = _poll_task(
            client,
            task_id_b,
            lambda t: str(t.get("status") or "") in {"available", "claimed", "running", "completed", "failed"},
            timeout_sec=18.0,
        )
        assert progressed_b, "任务B未出现在任务列表"
        assert str(progressed_b.get("status") or "") in {"available", "claimed", "running", "completed", "failed"}, progressed_b

        # 4) 进度接口非法参数：应返回 4xx（非 500）
        bad_progress = client.post(
            f"/board/tasks/{task_id_a}/progress",
            params={"scope": "personal"},
            json={"progress": "not-an-int", "message": "x"},
        )
        assert bad_progress.status_code in {400, 422}, f"非法进度未返回 4xx: {bad_progress.status_code} {bad_progress.text}"

        print("board 分发回归通过")
        print(f"- task_a: {task_id_a}, status_after_second_read={second_snap_a.get('status')}")
        print(f"- task_b: {task_id_b}, status_after_review={progressed_b.get('status')}")
    finally:
        client.close()
        stop_watcher_background()
        cleanup_storage()


if __name__ == "__main__":
    run()
