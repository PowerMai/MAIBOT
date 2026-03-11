#!/usr/bin/env python3
"""
任务状态投影回归（单一真源灰度）：
1) 开启 TASK_SINGLE_SOURCE_ENABLED
2) 通过 /board/tasks/{id} 状态迁移
3) 校验 status_projection_source/status_projection_at 已写入
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient


os.environ["TASK_SINGLE_SOURCE_ENABLED"] = "true"
os.environ["TASK_WATCHER_ENABLED"] = "false"
os.environ["FASTAPI_LIFESPAN_MINIMAL"] = "true"
os.environ["BOARD_CREATE_TASK_AUTO_DISPATCH"] = "false"

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402
from backend.engine.core.main_graph import cleanup_storage  # noqa: E402
from backend.engine.tasks.task_watcher import stop_watcher_background  # noqa: E402
from backend.engine.tasks.task_bidding import project_board_task_status  # noqa: E402
from backend.scripts.task_status_projection_test_utils import (  # noqa: E402
    assert_projection_present,
    create_human_review_task,
    create_task,
    get_task,
    must_status,
    submit_human_review_skip,
    write_json_report,
)


def run(report_json: str = "backend/data/task_status_projection_report.json") -> None:
    print("[projection-e2e] start", flush=True)
    cleanup_storage()
    client = TestClient(app)
    try:
        print("[projection-e2e] create base task", flush=True)
        task_id = create_task(client, subject="回归任务-状态投影", description="验证单一真源投影字段")

        print("[projection-e2e] patch running/completed", flush=True)
        to_running = client.patch(
            f"/board/tasks/{task_id}",
            json={"scope": "personal", "status": "running", "progress": 10},
        )
        must_status(to_running, 200, "迁移到 running")

        to_completed = client.patch(
            f"/board/tasks/{task_id}",
            json={"scope": "personal", "status": "completed", "result": "projection test done"},
        )
        completed_body = must_status(to_completed, 200, "迁移到 completed")
        task = completed_body.get("task") or {}
        assert str(task.get("status") or "") == "completed", task
        assert_projection_present(task, "board_api_patch", {"board_api_patch", "task_watcher", "thread"})

        final_snap = get_task(client, task_id, scope="personal")
        assert final_snap is not None, "最终快照未找到任务"
        assert str(final_snap.get("status") or "") == "completed", final_snap
        assert_projection_present(final_snap, "final_snapshot", {"board_api_patch", "task_watcher", "thread"})

        # blocked 路径在单一真源开启时，也应写入投影字段
        print("[projection-e2e] blocked projection check", flush=True)
        blocked_task_id = create_task(client, subject="回归任务-阻塞投影", description="验证 blocked 投影字段")
        blocked_resp = client.post(
            f"/board/tasks/{blocked_task_id}/blocked",
            params={"scope": "personal"},
            json={"reason": "缺少资质文件", "missing_info": ["营业执照", "资质证明"]},
        )
        if blocked_resp.status_code == 409:
            # 新状态机下，极短窗口内可能出现“初始状态未归一”导致 blocked 写冲突，先显式归一再重试。
            normalize_resp = client.patch(
                f"/board/tasks/{blocked_task_id}",
                json={"scope": "personal", "status": "available"},
            )
            must_status(normalize_resp, 200, "归一任务状态到 available")
            blocked_resp = client.post(
                f"/board/tasks/{blocked_task_id}/blocked",
                params={"scope": "personal"},
                json={"reason": "缺少资质文件", "missing_info": ["营业执照", "资质证明"]},
            )
        blocked_body = must_status(blocked_resp, 200, "报告 blocked")
        blocked_task = blocked_body.get("task") or {}
        assert str(blocked_task.get("status") or "") == "blocked", blocked_task
        assert_projection_present(blocked_task, "blocked_api", {"blocked_api", "task_watcher", "thread"})

        # watcher 同路径：claimed -> available 时应能显式清空 claimed_by
        print("[projection-e2e] claimed_by clear check", flush=True)
        reclaim_task_id = create_task(client, subject="回归任务-回队清理", description="验证 claimed_by 清理")
        claimed_resp = client.patch(
            f"/board/tasks/{reclaim_task_id}",
            json={"scope": "personal", "status": "claimed", "claimed_by": "worker-a", "progress": 5},
        )
        must_status(claimed_resp, 200, "迁移到 claimed")
        ok = project_board_task_status(
            task_id=reclaim_task_id,
            status="available",
            scope="personal",
            claimed_by=None,
            source="e2e_requeue_clear_claimed_by",
            only_when_status_in={"claimed"},
        )
        assert ok, "project_board_task_status 回队失败"
        reclaim_snap = get_task(client, reclaim_task_id, scope="personal")
        assert reclaim_snap is not None, "回队任务不存在"
        assert str(reclaim_snap.get("status") or "") == "available", reclaim_snap
        assert reclaim_snap.get("claimed_by") is None, reclaim_snap

        # human-review 路径也应写入投影来源
        print("[projection-e2e] human-review projection check", flush=True)
        human_task_id, checkpoint_id, _ = create_human_review_task(
            client,
            subject="回归任务-人审投影",
            description="验证 human-review 投影字段",
        )
        reviewed_task = submit_human_review_skip(
            client,
            task_id=human_task_id,
            checkpoint_id=checkpoint_id,
            feedback="skip for projection test",
        )
        assert_projection_present(reviewed_task, "human_review", {"human_review", "board_api_patch"})

        # accept-bid 防改派：已 claimed 给 A 后，B 不应抢占
        print("[projection-e2e] accept-bid anti-hijack check", flush=True)
        bid_task_id = create_task(client, subject="回归任务-accept-bid 防改派", description="验证 claimed 状态不可被其他角色抢占")
        bid_a_resp = client.post(
            f"/board/tasks/{bid_task_id}/bids",
            params={"scope": "personal"},
            headers={"X-Agent-Id": "worker-a"},
            json={"agent_id": "worker-a", "confidence": 0.7},
        )
        must_status(bid_a_resp, 200, "提交竞标 A")
        bid_b_resp = client.post(
            f"/board/tasks/{bid_task_id}/bids",
            params={"scope": "personal"},
            headers={"X-Agent-Id": "worker-b"},
            json={"agent_id": "worker-b", "confidence": 0.8},
        )
        must_status(bid_b_resp, 200, "提交竞标 B")
        preclaim_resp = client.patch(
            f"/board/tasks/{bid_task_id}",
            json={"scope": "personal", "status": "claimed", "claimed_by": "worker-a"},
        )
        must_status(preclaim_resp, 200, "预置 claimed_by=worker-a")
        accept_b_resp = client.post(
            f"/board/tasks/{bid_task_id}/accept-bid",
            params={"scope": "personal"},
            headers={"X-Agent-Id": "worker-b"},
            json={"agent_id": "worker-b"},
        )
        assert accept_b_resp.status_code == 409, accept_b_resp.text

        # board_update_task: claimed_by=null 应清空（通过 API 路径）
        print("[projection-e2e] api null clear check", flush=True)
        clear_claim_api_task_id = create_task(client, subject="回归任务-claimed_by API 清空", description="验证 patch 清空语义")
        set_claim_resp = client.patch(
            f"/board/tasks/{clear_claim_api_task_id}",
            json={"scope": "personal", "status": "claimed", "claimed_by": "worker-a"},
        )
        must_status(set_claim_resp, 200, "设置 claimed_by")
        clear_claim_resp = client.patch(
            f"/board/tasks/{clear_claim_api_task_id}",
            json={"scope": "personal", "status": "claimed", "claimed_by": None},
        )
        clear_claim_body = must_status(clear_claim_resp, 200, "清空 claimed_by")
        clear_claim_task = clear_claim_body.get("task") or {}
        assert clear_claim_task.get("claimed_by") is None, clear_claim_task

        # relay 状态守卫：blocked 任务不可直接 accept relay
        print("[projection-e2e] relay guard check", flush=True)
        relay_blocked_task_id = create_task(client, subject="回归任务-relay blocked 守卫", description="验证 blocked relay 拒绝")
        blocked_resp_for_relay = client.post(
            f"/board/tasks/{relay_blocked_task_id}/blocked",
            params={"scope": "personal"},
            json={"reason": "缺少审批信息", "missing_info": ["审批单"]},
        )
        must_status(blocked_resp_for_relay, 200, "relay 守卫前置 blocked")
        relay_create_resp = client.post(
            f"/board/tasks/{relay_blocked_task_id}/relay",
            params={"scope": "personal"},
            json={"from_role": "worker-a", "to_role": "worker-b", "relay_type": "delegate"},
        )
        relay_create_body = must_status(relay_create_resp, 200, "创建 relay")
        relay_id = str(relay_create_body.get("relay_id") or "")
        assert relay_id, relay_create_body
        relay_accept_resp = client.post(
            f"/board/relay/{relay_id}/accept",
            params={"scope": "personal", "agent_id": "worker-b"},
        )
        assert relay_accept_resp.status_code == 400, relay_accept_resp.text

        print("[projection-e2e] write report", flush=True)
        report_path = write_json_report(
            PROJECT_ROOT,
            report_json,
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "ok": True,
                "task_id": task_id,
                "final_status": str(final_snap.get("status") or ""),
                "status_projection_source": str(final_snap.get("status_projection_source") or ""),
                "status_projection_at": str(final_snap.get("status_projection_at") or ""),
                "blocked_task_id": blocked_task_id,
                "blocked_projection_source": str(blocked_task.get("status_projection_source") or ""),
                "human_review_task_id": human_task_id,
                "human_review_projection_source": str(reviewed_task.get("status_projection_source") or ""),
                "human_review_projection_at": str(reviewed_task.get("status_projection_at") or ""),
                "reclaim_task_id": reclaim_task_id,
                "reclaim_claimed_by": reclaim_snap.get("claimed_by"),
                "accept_bid_locked_task_id": bid_task_id,
                "claimed_by_cleared_via_api_task_id": clear_claim_api_task_id,
                "relay_blocked_guard_task_id": relay_blocked_task_id,
            },
        )

        print("task status projection 回归通过")
        print(f"- task_id: {task_id}")
        print(f"- status_projection_source: {final_snap.get('status_projection_source')}")
        print(f"- report: {report_path}")
    finally:
        client.close()
        stop_watcher_background()
        cleanup_storage()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="任务状态投影回归（单一真源）")
    parser.add_argument(
        "--report-json",
        default="backend/data/task_status_projection_report.json",
        help="回归报告输出路径（默认: backend/data/task_status_projection_report.json）",
    )
    args = parser.parse_args()
    run(report_json=str(args.report_json or "backend/data/task_status_projection_report.json"))
