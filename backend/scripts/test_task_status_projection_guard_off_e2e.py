#!/usr/bin/env python3
"""
任务状态投影回归（单一真源灰度关闭）：
1) 关闭 TASK_SINGLE_SOURCE_ENABLED
2) 通过 /board/tasks/{id} 与 human-review 触发状态迁移
3) 校验 status_projection_source/status_projection_at 不应写入
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import os
import sys
from pathlib import Path

from fastapi.testclient import TestClient


os.environ["TASK_SINGLE_SOURCE_ENABLED"] = "false"
os.environ["TASK_WATCHER_ENABLED"] = "false"
os.environ["FASTAPI_LIFESPAN_MINIMAL"] = "true"
os.environ["BOARD_CREATE_TASK_AUTO_DISPATCH"] = "false"

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402
from backend.engine.core.main_graph import cleanup_storage  # noqa: E402
from backend.engine.tasks.task_watcher import stop_watcher_background  # noqa: E402
from backend.scripts.task_status_projection_test_utils import (  # noqa: E402
    assert_projection_absent,
    create_human_review_task,
    create_task,
    must_status,
    submit_human_review_skip,
    write_json_report,
)


def run(report_json: str = "backend/data/task_status_projection_guard_off_report.json") -> None:
    print("[projection-guard-off] start", flush=True)
    cleanup_storage()
    client = TestClient(app)
    try:
        print("[projection-guard-off] create base task", flush=True)
        task_id = create_task(client, subject="回归任务-投影关闭", description="验证灰度关闭时不写投影字段")

        print("[projection-guard-off] patch running/completed", flush=True)
        to_running = client.patch(
            f"/board/tasks/{task_id}",
            json={"scope": "personal", "status": "running", "progress": 20},
        )
        must_status(to_running, 200, "迁移到 running")

        to_completed = client.patch(
            f"/board/tasks/{task_id}",
            json={"scope": "personal", "status": "completed", "result": "guard off projection test done"},
        )
        completed_body = must_status(to_completed, 200, "迁移到 completed")
        task = completed_body.get("task") or {}
        assert str(task.get("status") or "") == "completed", task
        assert_projection_absent(task, "board_api_patch")

        # blocked 路径在灰度关闭时不应写入投影字段
        print("[projection-guard-off] blocked projection absence", flush=True)
        blocked_task_id = create_task(client, subject="回归任务-阻塞投影关闭", description="验证 blocked 灰度关闭")
        blocked_resp = client.post(
            f"/board/tasks/{blocked_task_id}/blocked",
            params={"scope": "personal"},
            json={"reason": "缺少资料", "missing_info": ["证明A"]},
        )
        blocked_body = must_status(blocked_resp, 200, "报告 blocked")
        blocked_task = blocked_body.get("task") or {}
        assert str(blocked_task.get("status") or "") == "blocked", blocked_task
        assert_projection_absent(blocked_task, "blocked_api")

        print("[projection-guard-off] human-review projection absence", flush=True)
        human_task_id, checkpoint_id, _ = create_human_review_task(
            client,
            subject="回归任务-人审投影关闭",
            description="验证 human-review 灰度关闭",
        )
        reviewed_task = submit_human_review_skip(
            client,
            task_id=human_task_id,
            checkpoint_id=checkpoint_id,
            feedback="skip for guard-off test",
        )
        assert_projection_absent(reviewed_task, "human_review")

        print("[projection-guard-off] write report", flush=True)
        report_path = write_json_report(
            PROJECT_ROOT,
            report_json,
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "ok": True,
                "task_id": task_id,
                "final_status": str(task.get("status") or ""),
                "status_projection_source": str(task.get("status_projection_source") or ""),
                "status_projection_at": str(task.get("status_projection_at") or ""),
                "blocked_task_id": blocked_task_id,
                "blocked_projection_source": str(blocked_task.get("status_projection_source") or ""),
                "human_review_task_id": human_task_id,
                "human_review_projection_source": str(reviewed_task.get("status_projection_source") or ""),
                "human_review_projection_at": str(reviewed_task.get("status_projection_at") or ""),
            },
        )

        print("task status projection guard-off 回归通过")
        print(f"- task_id: {task_id}")
        print(f"- report: {report_path}")
    finally:
        client.close()
        stop_watcher_background()
        cleanup_storage()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="任务状态投影回归（灰度关闭）")
    parser.add_argument(
        "--report-json",
        default="backend/data/task_status_projection_guard_off_report.json",
        help="回归报告输出路径（默认: backend/data/task_status_projection_guard_off_report.json）",
    )
    args = parser.parse_args()
    run(report_json=str(args.report_json or "backend/data/task_status_projection_guard_off_report.json"))
