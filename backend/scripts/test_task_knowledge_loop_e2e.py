#!/usr/bin/env python3
"""
任务流 E2E 校验：
创建任务 -> 人审检查点 -> 完成任务 -> 学习沉淀落盘
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient


PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402


def _load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                rows.append(obj)
        except Exception:
            continue
    return rows


def _advance_task_to_running(client: TestClient, task_id: str, scope: str, current_status: str) -> str:
    status = str(current_status or "").strip().lower()
    if status == "available":
        r = client.patch(
            f"/board/tasks/{task_id}",
            json={"scope": scope, "status": "claimed"},
        )
        assert r.status_code == 200, f"推进 claimed 失败: {r.status_code} {r.text}"
        status = str((r.json().get("task") or {}).get("status") or status).strip().lower()
    if status == "claimed":
        r = client.patch(
            f"/board/tasks/{task_id}",
            json={"scope": scope, "status": "running"},
        )
        assert r.status_code == 200, f"推进 running 失败: {r.status_code} {r.text}"
        status = str((r.json().get("task") or {}).get("status") or status).strip().lower()
    return status


def run() -> None:
    client = TestClient(app)
    try:
        # 1) 创建带人审检查点任务
        create_body = {
            "subject": "E2E 验证任务：知识沉淀闭环",
            "description": "用于校验 human checkpoint 与 learning loop。",
            "priority": 3,
            "scope": "personal",
            "source_channel": "e2e",
            "cost_tier": "low",
            "required_skills": ["knowledge-building", "text_analysis"],
            "human_checkpoints": [
                {"after_step": "计划草案", "action": "review", "description": "确认后再继续"}
            ],
            "skill_profile": "knowledge",
        }
        r = client.post("/board/tasks", json=create_body)
        assert r.status_code == 200, f"创建任务失败: {r.status_code} {r.text}"
        task = r.json().get("task") or {}
        task_id = task.get("id")
        assert task_id, f"创建任务响应异常: {r.text}"

        # 2) 置为待确认，然后提交人审通过
        r = client.patch(f"/board/tasks/{task_id}", json={"scope": "personal", "status": "waiting_human"})
        assert r.status_code == 200, f"设置待确认失败: {r.status_code} {r.text}"

        checkpoint_id = (
            ((r.json().get("task") or {}).get("human_checkpoints") or [{}])[0].get("checkpoint_id")
            or "计划草案-review-0"
        )
        r = client.post(
            f"/board/tasks/{task_id}/human-review",
            params={"scope": "personal"},
            json={"checkpoint_id": checkpoint_id, "decision": "approve", "feedback": "通过"},
        )
        assert r.status_code == 200, f"提交人审失败: {r.status_code} {r.text}"
        reviewed_task = r.json().get("task") or {}
        assert reviewed_task.get("status") in {"running", "available", "claimed"}, "人审后状态异常"
        assert isinstance(reviewed_task.get("decision_points"), list), "缺少决策点记录"

        # 3) 若人审后仍是 available/claimed，先推进到 running，再完成任务（对齐状态机约束）
        _advance_task_to_running(
            client=client,
            task_id=task_id,
            scope="personal",
            current_status=str(reviewed_task.get("status") or ""),
        )

        # 4) 完成任务，触发沉淀
        r = client.patch(
            f"/board/tasks/{task_id}",
            json={
                "scope": "personal",
                "status": "completed",
                "result": "任务已完成：生成执行计划并输出风险提示。",
                "deliverables": ["outputs/e2e-plan.md"],
            },
        )
        assert r.status_code == 200, f"完成任务失败: {r.status_code} {r.text}"
        completed_task = r.json().get("task") or {}
        assert completed_task.get("status") == "completed", "任务未完成"
        assert (completed_task.get("skill_hints") or []), "未生成 skill_hints"

        # 5) 校验沉淀文件
        success_rows = _load_jsonl(PROJECT_ROOT / "data" / "task_success_patterns.jsonl")
        entity_rows = _load_jsonl(PROJECT_ROOT / "data" / "task_entities_relations.jsonl")
        assert any(str(x.get("task_id")) == str(task_id) for x in success_rows), "成功模式未落盘"
        assert any(str(x.get("task_id")) == str(task_id) for x in entity_rows), "实体关系未落盘"

        print("E2E 校验通过")
        print(f"- task_id: {task_id}")
        print(f"- skill_hints: {completed_task.get('skill_hints')}")
        print(f"- decision_points: {len(completed_task.get('decision_points') or [])}")
    finally:
        client.close()


if __name__ == "__main__":
    run()

