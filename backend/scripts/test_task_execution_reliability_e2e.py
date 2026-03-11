#!/usr/bin/env python3
"""
任务执行可靠性回归（恢复 + 去重 + 隔离）：
1) 创建失败任务并触发 /resume，校验可恢复
2) 上报 /step-complete 两次同 step_id，校验幂等去重
3) 创建第二个任务，校验 completed_step_ids 不串任务（跨线程隔离）
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient


os.environ["TASK_EXECUTION_RELIABILITY_V2"] = "true"
os.environ["TASK_WATCHER_ENABLED"] = "false"
os.environ["FASTAPI_LIFESPAN_MINIMAL"] = "true"
os.environ["BOARD_CREATE_TASK_AUTO_DISPATCH"] = "false"

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402
from backend.engine.core.main_graph import cleanup_storage  # noqa: E402
from backend.engine.tasks.task_watcher import stop_watcher_background  # noqa: E402


def _must_status(resp, code: int, stage: str) -> dict:
    if resp.status_code != code:
        raise AssertionError(f"{stage} 失败: HTTP {resp.status_code}, body={resp.text[:400]}")
    body = resp.json() if hasattr(resp, "json") else {}
    if isinstance(body, dict):
        return body
    return {}


def _write_json_report(relative_path: str, payload: dict) -> str:
    report_path = PROJECT_ROOT / relative_path
    report_path.parent.mkdir(parents=True, exist_ok=True)
    import json

    report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report_path.as_posix()


def _create_task(client: TestClient, subject: str, description: str) -> str:
    body = _must_status(
        client.post(
            "/board/tasks",
            json={
                "subject": subject,
                "description": description,
                "scope": "personal",
                "source_channel": "ci",
            },
        ),
        200,
        "创建任务",
    )
    task_id = str(body.get("task_id") or "")
    if not task_id:
        raise AssertionError(f"创建任务未返回 task_id: {body}")
    return task_id


def run(report_json: str = "backend/data/task_execution_reliability_e2e_report.json") -> None:
    print("[task-exec-reliability-e2e] start", flush=True)
    cleanup_storage()
    client = TestClient(app)
    try:
        task_id = _create_task(client, "回归任务-恢复与去重", "验证 resume/step-complete 幂等")
        _must_status(
            client.patch(
                f"/board/tasks/{task_id}",
                json={
                    "scope": "personal",
                    "status": "failed",
                    "thread_id": f"thread-{task_id[:8]}",
                    "result": "intentional failure for e2e",
                },
            ),
            200,
            "置为 failed",
        )

        resume_body = _must_status(
            client.post(
                f"/board/tasks/{task_id}/resume",
                json={
                    "scope": "personal",
                    "reason": "e2e_resume",
                    "thread_id": f"thread-{task_id[:8]}",
                    # 避免测试依赖外部 LangGraph 线程接口，直接走分发兜底。
                    "force_prompt_fallback": True,
                },
            ),
            200,
            "调用 resume",
        )
        assert bool(resume_body.get("resumed")) is True, resume_body

        run_id = "run-e2e-001"
        first_step = _must_status(
            client.post(
                f"/board/tasks/{task_id}/runs/{run_id}/step-complete",
                json={
                    "scope": "personal",
                    "step_id": "step-prepare-context",
                    "step_seq": 1,
                    "event_seq": 11,
                    "result_digest": "ok",
                },
            ),
            200,
            "首次 step-complete",
        )
        assert bool(first_step.get("deduped")) is False, first_step

        second_step = _must_status(
            client.post(
                f"/board/tasks/{task_id}/runs/{run_id}/step-complete",
                json={
                    "scope": "personal",
                    "step_id": "step-prepare-context",
                    "step_seq": 1,
                    "event_seq": 12,
                    "result_digest": "ok-replay",
                },
            ),
            200,
            "重复 step-complete",
        )
        assert bool(second_step.get("deduped")) is True, second_step

        state_body = _must_status(
            client.get(f"/board/tasks/{task_id}/execution-state", params={"scope": "personal"}),
            200,
            "读取执行状态",
        )
        execution = ((state_body.get("state") or {}).get("execution") or {}) if isinstance(state_body, dict) else {}
        completed = execution.get("completed_step_ids") if isinstance(execution, dict) else []
        completed = completed if isinstance(completed, list) else []
        assert completed.count("step-prepare-context") == 1, completed

        task2_id = _create_task(client, "回归任务-隔离校验", "验证跨任务步骤账本不串扰")
        task2_state = _must_status(
            client.get(f"/board/tasks/{task2_id}/execution-state", params={"scope": "personal"}),
            200,
            "读取任务2执行状态",
        )
        execution2 = ((task2_state.get("state") or {}).get("execution") or {}) if isinstance(task2_state, dict) else {}
        completed2 = execution2.get("completed_step_ids") if isinstance(execution2, dict) else []
        completed2 = completed2 if isinstance(completed2, list) else []
        assert "step-prepare-context" not in completed2, completed2

        report = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "ok": True,
            "task_id": task_id,
            "task2_id": task2_id,
            "resume_mode": str(resume_body.get("mode") or ""),
            "dedup_first": bool(first_step.get("deduped")),
            "dedup_second": bool(second_step.get("deduped")),
            "completed_step_ids": completed,
            "isolation_ok": "step-prepare-context" not in completed2,
        }
        report_path = _write_json_report(report_json, report)
        print("task execution reliability e2e 通过")
        print(f"- task_id: {task_id}")
        print(f"- report: {report_path}")
    finally:
        client.close()
        stop_watcher_background()
        cleanup_storage()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="任务执行可靠性回归（恢复+去重+隔离）")
    parser.add_argument(
        "--report-json",
        default="backend/data/task_execution_reliability_e2e_report.json",
        help="回归报告输出路径（默认: backend/data/task_execution_reliability_e2e_report.json）",
    )
    args = parser.parse_args()
    run(report_json=str(args.report_json or "backend/data/task_execution_reliability_e2e_report.json"))
