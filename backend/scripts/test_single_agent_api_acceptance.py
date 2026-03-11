#!/usr/bin/env python3
"""
单体 Agent 阶段 API 验收回归（关键路径）：
1) plan 确认任务创建与初始状态
2) blocked 上报与恢复状态迁移
3) artifacts 上报落库
4) human-review 扩展决策（delegate / skip）
5) reliability 指标接口可读
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi.testclient import TestClient


PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402
from backend.engine.core.main_graph import cleanup_storage  # noqa: E402
from backend.engine.tasks.task_watcher import stop_watcher_background  # noqa: E402


def _must_status(resp, expected: int, action: str) -> Dict[str, Any]:
    assert resp.status_code == expected, f"{action} 失败: {resp.status_code} {resp.text}"
    body = resp.json()
    assert isinstance(body, dict), f"{action} 响应不是对象: {body}"
    return body


def _get_task(client: TestClient, task_id: str, scope: str = "personal", headers: dict | None = None) -> Optional[Dict[str, Any]]:
    h = headers or _internal_headers()
    resp = client.get("/board/tasks", params={"scope": scope}, headers=h)
    body = _must_status(resp, 200, "读取任务列表")
    tasks = body.get("tasks") or []
    for row in tasks:
        if str((row or {}).get("id")) == str(task_id):
            return row
    return None


def _assert_rate_limit_middleware() -> None:
    limiter = getattr(getattr(app, "state", object()), "limiter", None)
    if limiter is not None:
        return
    message = (
        "检测到 app.state.limiter 为 None（slowapi 未生效）。"
        "CI 环境必须安装并启用 slowapi；本地环境请执行 `pip install -e \".[dev]\"` 后重试。"
    )
    strict_flag = str(os.getenv("STRICT_RATE_LIMIT_CHECK", "")).strip().lower()
    if strict_flag in {"1", "true", "yes"}:
        raise AssertionError(message)
    print(f"[single-agent-api][warn] {message}")


def _internal_headers() -> dict[str, str]:
    """内部 API 认证头（与 deps.verify_internal_token 对齐）。无 token 时返回空，TestClient 以 testclient 连接会被 deps 放行。"""
    token = os.environ.get("INTERNAL_API_TOKEN", "").strip()
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


def run() -> None:
    cleanup_storage()
    _assert_rate_limit_middleware()
    client = TestClient(app)
    headers = _internal_headers()
    try:
        # A. 创建要求 plan 确认的任务
        create_plan = client.post(
            "/board/tasks",
            headers=headers,
            json={
                "subject": "回归任务-PlanConfirm",
                "description": "验证 awaiting_plan_confirm -> available/running 链路",
                "scope": "personal",
                "require_plan_confirmation": True,
            },
        )
        body_plan = _must_status(create_plan, 200, "创建 plan 确认任务")
        task_plan = body_plan.get("task") or {}
        task_plan_id = str(body_plan.get("task_id") or task_plan.get("id") or "")
        assert task_plan_id, f"任务ID缺失: {body_plan}"
        assert str(task_plan.get("status") or "") == "awaiting_plan_confirm", task_plan
        assert str(body_plan.get("dispatch_state") or "") == "awaiting_plan_confirm", body_plan

        # B. 阻塞上报 + 恢复 + 进入 running
        blocked = client.post(
            f"/board/tasks/{task_plan_id}/blocked",
            params={"scope": "personal"},
            headers=headers,
            json={
                "reason": "缺少业务输入参数",
                "missing_info": ["客户行业", "预算上限"],
            },
        )
        blocked_body = _must_status(blocked, 200, "上报 blocked")
        blocked_task = blocked_body.get("task") or {}
        assert str(blocked_task.get("status") or "") == "blocked", blocked_task
        assert str(blocked_task.get("blocked_reason") or "") == "缺少业务输入参数", blocked_task
        assert isinstance(blocked_task.get("missing_information"), list), blocked_task

        recover_available = client.patch(
            f"/board/tasks/{task_plan_id}",
            headers=headers,
            json={"scope": "personal", "status": "available", "progress_message": "信息补充后恢复"},
        )
        recovered_body = _must_status(recover_available, 200, "blocked 恢复到 available")
        assert str((recovered_body.get("task") or {}).get("status") or "") == "available", recovered_body

        to_running = client.patch(
            f"/board/tasks/{task_plan_id}",
            headers=headers,
            json={"scope": "personal", "status": "running"},
        )
        running_body = _must_status(to_running, 200, "available 迁移到 running")
        assert str((running_body.get("task") or {}).get("status") or "") == "running", running_body

        # C. 成果物上报落库
        artifacts = client.post(
            f"/board/tasks/{task_plan_id}/artifacts",
            params={"scope": "personal"},
            headers=headers,
            json={
                "deliverables": ["回归报告草案", "执行日志摘录"],
                "changed_files": ["backend/api/app.py", "frontend/desktop/src/components/TaskDetailView.tsx"],
                "rollback_hint": "若回退则恢复 board 状态字段扩展与 UI 展示分支",
            },
        )
        artifacts_body = _must_status(artifacts, 200, "上报 artifacts")
        artifacts_task = artifacts_body.get("task") or {}
        assert len(artifacts_task.get("deliverables") or []) >= 2, artifacts_task
        assert len(artifacts_task.get("changed_files") or []) >= 2, artifacts_task
        assert str(artifacts_task.get("rollback_hint") or "").strip(), artifacts_task

        # D. human-review 扩展决策：delegate / skip
        create_human = client.post(
            "/board/tasks",
            headers=headers,
            json={
                "subject": "回归任务-HumanCheckpoint",
                "description": "验证 delegate / skip 决策语义",
                "scope": "personal",
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
        body_human = _must_status(create_human, 200, "创建 human checkpoint 任务")
        task_human = body_human.get("task") or {}
        task_human_id = str(body_human.get("task_id") or task_human.get("id") or "")
        assert task_human_id, f"任务ID缺失: {body_human}"
        assert str(task_human.get("status") or "") == "waiting_human", task_human
        checkpoints = task_human.get("human_checkpoints") or []
        checkpoint_id = str((checkpoints[0] or {}).get("checkpoint_id") or "").strip()
        assert checkpoint_id, f"checkpoint_id 缺失: {task_human}"

        delegate_resp = client.post(
            f"/board/tasks/{task_human_id}/human-review",
            params={"scope": "personal"},
            headers=headers,
            json={"checkpoint_id": checkpoint_id, "decision": "delegate", "feedback": "委派给领域专家"},
        )
        delegate_body = _must_status(delegate_resp, 200, "提交 delegate 决策")
        assert str((delegate_body.get("task") or {}).get("status") or "") == "paused", delegate_body

        skip_resp = client.post(
            f"/board/tasks/{task_human_id}/human-review",
            params={"scope": "personal"},
            headers=headers,
            json={"checkpoint_id": checkpoint_id, "decision": "skip", "feedback": "跳过该检查点"},
        )
        skip_body = _must_status(skip_resp, 200, "提交 skip 决策")
        # skip 语义：有执行线程则回到 running；无执行线程则回到 available 交由分发链路继续。
        assert str((skip_body.get("task") or {}).get("status") or "") in {"running", "available"}, skip_body

        # E. reliability 指标接口
        metrics_resp = client.get("/board/metrics/reliability", params={"scope": "personal", "window_hours": 72}, headers=headers)
        metrics_body = _must_status(metrics_resp, 200, "读取 reliability 指标")
        assert bool(metrics_body.get("ok")), metrics_body
        metrics = metrics_body.get("metrics") or {}
        for key in [
            "task_count",
            "success_rate",
            "blocked_recovery_rate",
            "human_intervention_rate",
            "deliverable_effective_rate",
        ]:
            assert key in metrics, f"metrics 缺少字段 {key}: {metrics}"
        assert int(metrics.get("task_count") or 0) >= 2, metrics
        assert int(metrics.get("human_intervened_count") or 0) >= 1, metrics

        # F. 快照验证（最终数据可见）
        final_plan = _get_task(client, task_plan_id, scope="personal", headers=headers)
        assert final_plan is not None, "plan 任务未出现在最终列表"
        assert len(final_plan.get("changed_files") or []) >= 2, final_plan

        print("single-agent API 验收通过")
        print(f"- plan_task: {task_plan_id}")
        print(f"- human_task: {task_human_id}")
        print(f"- metrics.task_count: {metrics.get('task_count')}")
        print(f"- metrics.human_intervened_count: {metrics.get('human_intervened_count')}")
    finally:
        client.close()
        stop_watcher_background()
        cleanup_storage()


if __name__ == "__main__":
    run()

